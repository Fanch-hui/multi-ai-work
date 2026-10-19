import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationRequiredError } from '../src/domain/provider.js';
import { configureProviderFetch } from '../src/providers/network.js';
import {
  getOAuthAccessToken,
  OAUTH_ISSUER,
  type OAuthTokens,
} from '../src/providers/managed/oauth-tokens.js';

afterEach(() => {
  configureProviderFetch((input, init) => fetch(input, init));
  vi.useRealTimers();
});

function fixture(expiresAt = 0): OAuthTokens {
  return {
    client_id: 'fixture-client',
    subject: 'fixture-subject',
    issuer: OAUTH_ISSUER,
    ext_agent_host_id: 'fixture-host',
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    id_token: 'fixture-id',
    token_type: 'Bearer',
    scopes: ['chatgpt.tokens.use.direct'],
    expires_at: expiresAt,
  };
}
const renewed = () =>
  new Response(
    JSON.stringify({
      access_token: 'fixture-renewed-access',
      refresh_token: 'fixture-renewed-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    }),
    { headers: { 'content-type': 'application/json' } },
  );

describe('OAuth refresh lifecycle', () => {
  it('serializes credential reads with refresh and persists rotation before sharing the result', async () => {
    let stored = JSON.stringify(fixture()),
      reads = 0,
      requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    configureProviderFetch(async (_input, init) => {
      requests++;
      expect(new URLSearchParams(init!.body as URLSearchParams).get('refresh_token')).toBe(
        'fixture-refresh',
      );
      return renewed();
    });
    const get = async () => {
      reads++;
      const value = stored;
      await gate;
      return value;
    };
    const save = async (_ref: string, value: string) => {
      stored = value;
    };
    const first = getOAuthAccessToken('fixture-concurrent', get, save);
    const second = getOAuthAccessToken('fixture-concurrent', get, save);
    await Promise.resolve();
    expect(reads).toBe(1);
    release();
    const records = await Promise.all([first, second]);
    expect(requests).toBe(1);
    expect(records[0]).toBe(records[1]);
    expect(JSON.parse(stored)).toMatchObject({
      access_token: 'fixture-renewed-access',
      refresh_token: 'fixture-renewed-refresh',
    });
    expect(await getOAuthAccessToken('fixture-concurrent', get, save)).toEqual(JSON.parse(stored));
    expect(requests).toBe(1);
  });

  it('uses an unexpired access token when early refresh is temporarily refused and retries after expiry', async () => {
    vi.useFakeTimers();
    const record = fixture(Date.now() + 30_000),
      get = async () => JSON.stringify(record),
      save = vi.fn();
    configureProviderFetch(async () => new Response('fixture-private-response', { status: 403 }));
    expect(await getOAuthAccessToken('fixture-temporary', get, save)).toEqual(record);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_001);
    await expect(getOAuthAccessToken('fixture-temporary', get, save)).rejects.toThrow('HTTP 403');
    try {
      await getOAuthAccessToken('fixture-temporary', get, save);
    } catch (error) {
      expect(error).not.toBeInstanceOf(AuthenticationRequiredError);
      expect((error as Error).message).not.toMatch(/重新登录|fixture-private-response/);
    }
  });

  it.each([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ])('requires sign-in for an explicit %s response', async (code) => {
    const record = fixture(Date.now() + 30_000),
      save = vi.fn();
    configureProviderFetch(
      async () =>
        new Response(JSON.stringify({ error: { code, message: 'fixture-private-message' } }), {
          status: 403,
        }),
    );
    await expect(
      getOAuthAccessToken(`fixture-${code}`, async () => JSON.stringify(record), save),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(save).not.toHaveBeenCalled();
  });

  it('reports persistence failures instead of returning the previous access token', async () => {
    const stored = JSON.stringify(fixture(Date.now() + 30_000));
    configureProviderFetch(async () => renewed());
    const save = async () => {
      throw new Error('fixture-save-failed');
    };
    await expect(getOAuthAccessToken('fixture-save', async () => stored, save)).rejects.toThrow(
      'fixture-save-failed',
    );
  });

  it('preserves cancellation during early refresh', async () => {
    const controller = new AbortController(),
      save = vi.fn();
    configureProviderFetch(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      getOAuthAccessToken(
        'fixture-cancel',
        async () => JSON.stringify(fixture(Date.now() + 30_000)),
        save,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(DOMException);
    expect(controller.signal.aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['initiator', 'joiner'])(
    'keeps shared rotation alive when its %s stops waiting',
    async (cancelledCaller) => {
      const controller = new AbortController();
      let stored = JSON.stringify(fixture()),
        requests = 0;
      let started!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      configureProviderFetch(async (_url, init) => {
        requests++;
        started();
        await gate;
        expect(init?.signal?.aborted).toBe(false);
        return renewed();
      });
      const get = async () => stored,
        save = async (_ref: string, value: string) => {
          stored = value;
        };
      const first = getOAuthAccessToken(
        `fixture-cancel-${cancelledCaller}`,
        get,
        save,
        cancelledCaller === 'initiator' ? controller.signal : undefined,
      );
      await ready;
      const second = getOAuthAccessToken(
        `fixture-cancel-${cancelledCaller}`,
        get,
        save,
        cancelledCaller === 'joiner' ? controller.signal : undefined,
      );
      const cancelled = cancelledCaller === 'initiator' ? first : second;
      const continued = cancelledCaller === 'initiator' ? second : first;
      controller.abort(new Error('fixture-caller-stopped'));
      await expect(cancelled).rejects.toThrow('fixture-caller-stopped');
      const third = getOAuthAccessToken(`fixture-cancel-${cancelledCaller}`, get, save);
      release();
      const records = await Promise.all([continued, third]);
      expect(requests).toBe(1);
      expect(records[0]).toBe(records[1]);
      expect(JSON.parse(stored)).toMatchObject({
        access_token: 'fixture-renewed-access',
        refresh_token: 'fixture-renewed-refresh',
      });
    },
  );

  it('does not begin a credential read for an already cancelled caller', async () => {
    const get = vi.fn();
    await expect(
      getOAuthAccessToken('fixture-already-cancelled', get, undefined, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(DOMException);
    expect(get).not.toHaveBeenCalled();
  });

  it('serializes renewal after explicit expiry rejection and reuses a concurrently rotated token', async () => {
    let stored = JSON.stringify(fixture(Date.now() + 3600_000)),
      requests = 0;
    configureProviderFetch(async () => {
      requests++;
      return renewed();
    });
    const get = async () => stored,
      save = async (_ref: string, value: string) => {
        stored = value;
      };
    const initial = getOAuthAccessToken('fixture-rejected', get, save);
    const records = await Promise.all([
      getOAuthAccessToken('fixture-rejected', get, save, undefined, 'fixture-access'),
      getOAuthAccessToken('fixture-rejected', get, save, undefined, 'fixture-access'),
    ]);
    expect(await initial).toMatchObject({ access_token: 'fixture-access' });
    expect(requests).toBe(1);
    expect(records[0]).toBe(records[1]);
    expect(
      await getOAuthAccessToken('fixture-rejected', get, save, undefined, 'fixture-access'),
    ).toMatchObject({ access_token: 'fixture-renewed-access' });
    expect(requests).toBe(1);
  });

  it('does not fall back to a server-rejected access token when refresh is unavailable', async () => {
    const record = fixture(Date.now() + 3600_000);
    configureProviderFetch(async () => new Response('{}', { status: 503 }));
    await expect(
      getOAuthAccessToken(
        'fixture-rejected-unavailable',
        async () => JSON.stringify(record),
        async () => {},
        undefined,
        record.access_token,
      ),
    ).rejects.toThrow('HTTP 503');
  });
});
