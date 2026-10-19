import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import { configureProviderFetch } from '../src/providers/network.js';
import { createOAuthClient } from '../src/providers/managed/oauth-client.js';
import { OAUTH_ISSUER } from '../src/providers/managed/oauth-tokens.js';

afterEach(() => configureProviderFetch((input, init) => fetch(input, init)));

function context(bindingId: string, runId: string): RunContext {
  let stored = JSON.stringify({
    client_id: 'fixture-client',
    subject: 'fixture-subject',
    issuer: OAUTH_ISSUER,
    ext_agent_host_id: 'fixture-host',
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    id_token: 'fixture-id',
    token_type: 'Bearer',
    scopes: ['chatgpt.tokens.use.direct'],
    expires_at: Date.now() + 3600000,
  });
  return {
    runId,
    binding: { id: bindingId } as RunContext['binding'],
    connection: {
      provider: 'chatgpt',
      secretRef: `fixture-${bindingId}`,
    } as RunContext['connection'],
    signal: new AbortController().signal,
    getSecret: async () => stored,
    saveSecret: async (_ref, value) => {
      stored = value;
    },
  } as RunContext;
}
const completed = () =>
  new Response(JSON.stringify({ id: 'resp_fixture', status: 'completed', output: [] }), {
    headers: { 'content-type': 'application/json' },
  });
const request = (run: RunContext) =>
  createOAuthClient(run).responses.create({ model: 'gpt-6.1-sol', input: '收到' });

describe('ChatGPT session routing', () => {
  it('retains the session across runs and separates different bindings', async () => {
    const sessions: (string | null)[] = [];
    configureProviderFetch(async (_input, init) => {
      sessions.push(new Headers(init?.headers).get('session-id'));
      return completed();
    });
    await request(context('binding-a', 'run-1'));
    await request(context('binding-a', 'run-2'));
    await request(context('binding-b', 'run-3'));
    expect(sessions).toEqual(['binding-a', 'binding-a', 'binding-b']);
  });

  it('keeps the same routing identity when an expired access token is refreshed', async () => {
    const sessions: (string | null)[] = [],
      authorization: (string | null)[] = [];
    configureProviderFetch(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (String(input).endsWith('/oauth/token')) {
        expect(headers.has('session-id')).toBe(false);
        return new Response(
          JSON.stringify({
            access_token: 'fixture-renewed',
            refresh_token: 'fixture-next',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      sessions.push(headers.get('session-id'));
      authorization.push(headers.get('authorization'));
      return sessions.length === 1
        ? new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 })
        : completed();
    });
    await request(context('binding-refresh', 'run-4'));
    expect(sessions).toEqual(['binding-refresh', 'binding-refresh']);
    expect(authorization).toEqual(['Bearer fixture-access', 'Bearer fixture-renewed']);
  });
});
