import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionLogin } from '../src/core/connection-login.js';
import { State } from '../src/core/state.js';
import type { Connection } from '../src/domain/types.js';
import type { OAuthStatus } from '../src/security/oauth.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class ControlledOAuth {
  statuses = new Map<string, OAuthStatus>();
  start = vi.fn(async (id: string) => { this.statuses.set(id, { status: 'pending' }); return { url: `https://example.test/${id}` }; });
  status(id: string): OAuthStatus { return this.statuses.get(id) ?? { status: 'idle' }; }
  cancel = vi.fn((id: string) => { this.statuses.set(id, { status: 'cancelled' }); });
  connection = vi.fn(async (id: string) => ({ secretRef: `chatgpt:${id}`, accountScope: 'test-account' }));
}

describe('connection login lifecycle', () => {
  let root: string, state: State, oauth: ControlledOAuth, login: ConnectionLogin;
  const stored = (id = 'first') => state.storage.get<Connection>('connections', id)!;
  const seed = (id = 'first') => state.storage.put('connections', { id, name: id, provider: 'chatgpt', revision: 1,
    concurrency: 1, status: 'ready', models: [], error: 'old error', createdAt: new Date().toISOString() } satisfies Connection);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'multi-ai-login-'));
    state = new State(root); oauth = new ControlledOAuth(); login = new ConnectionLogin(state, oauth);
    seed(); vi.useFakeTimers();
  });
  afterEach(async () => {
    login.close();
    if (state.storage.db.open) state.storage.close();
    vi.useRealTimers(); await rm(root, { recursive: true, force: true });
  });

  it('persists login and terminal success once, with one polling timer', async () => {
    await login.start('first');
    expect(stored()).toMatchObject({ revision: 2, status: 'needs_auth' });
    expect(stored().error).toBeUndefined();
    const result = deferred<{ secretRef: string; accountScope: string }>();
    oauth.connection.mockImplementationOnce(() => result.promise);
    oauth.statuses.set('first', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
    result.resolve({ secretRef: 'chatgpt:first', accountScope: 'new-account' });
    await Promise.resolve();
    expect(stored()).toMatchObject({ revision: 2, status: 'untested', accountScope: 'new-account', secretRef: 'chatgpt:first' });
    expect(oauth.connection).toHaveBeenCalledTimes(1);
  });

  it('serializes replacement starts for one connection while other connections start independently', async () => {
    seed('second');
    const opening = deferred<{ url: string }>();
    oauth.start.mockImplementationOnce(() => opening.promise);
    const first = login.start('first');
    const cancelled = expect(first).rejects.toThrow('登录已取消');
    await Promise.resolve(); await Promise.resolve();
    const replacement = login.start('first');
    await login.start('second');
    expect(oauth.start.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
    opening.resolve({ url: 'https://example.test/old' });
    await cancelled; await replacement;
    expect(oauth.start.mock.calls.map(([id]) => id)).toEqual(['first', 'second', 'first']);
    expect(stored()).toMatchObject({ revision: 3, status: 'needs_auth' });
    expect(vi.getTimerCount()).toBe(2);
  });

  it('does not let a late terminal result overwrite a replacement login', async () => {
    const old = deferred<{ secretRef: string; accountScope: string }>();
    oauth.connection.mockImplementationOnce(() => old.promise);
    await login.start('first'); oauth.statuses.set('first', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(1000);
    await login.start('first');
    old.resolve({ secretRef: 'old-ref', accountScope: 'old-account' }); await Promise.resolve();
    expect(stored()).toMatchObject({ revision: 3, status: 'needs_auth' });
    expect(stored().accountScope).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['delete', 'revision', 'provider'] as const)('ignores terminal success after a connection %s change', async change => {
    const result = deferred<{ secretRef: string; accountScope: string }>();
    oauth.connection.mockImplementationOnce(() => result.promise);
    await login.start('first'); oauth.statuses.set('first', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(1000);
    if (change === 'delete') state.storage.delete('connections', 'first');
    else state.storage.put('connections', { ...stored(), status: 'ready',
      ...(change === 'revision' ? { revision: 3 } : { provider: 'custom' }) });
    result.resolve({ secretRef: 'late-ref', accountScope: 'late-account' }); await Promise.resolve();
    if (change === 'delete') expect(stored()).toBeUndefined();
    else { expect(stored().status).toBe('ready'); expect(stored().accountScope).toBeUndefined(); }
  });

  it('saves terminal failures safely and recovers from a failed start', async () => {
    oauth.start.mockRejectedValueOnce(new Error('start failed'));
    await expect(login.start('first')).rejects.toThrow('start failed');
    expect(stored()).toMatchObject({ revision: 2, status: 'needs_auth', error: 'start failed' });
    await login.start('first');
    oauth.statuses.set('first', { status: 'error', error: 'access sk-abcdefghijklmnopqrstuvwxyz denied' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored()).toMatchObject({ revision: 3, status: 'needs_auth', error: 'access [已隐藏] denied' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel clears polling and invalidates a terminal result already in progress', async () => {
    const result = deferred<{ secretRef: string; accountScope: string }>();
    oauth.connection.mockImplementationOnce(() => result.promise);
    await login.start('first'); oauth.statuses.set('first', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(1000);
    login.cancel('first');
    result.resolve({ secretRef: 'late-ref', accountScope: 'late-account' }); await Promise.resolve();
    expect(stored()).toMatchObject({ revision: 2, status: 'needs_auth' });
    expect(stored().accountScope).toBeUndefined();
    await login.start('first'); login.cancel('first');
    expect(vi.getTimerCount()).toBe(0);
    expect(oauth.status('first').status).toBe('cancelled');
  });

  it('cancels polling and prevents asynchronous writes after closing the database', async () => {
    seed('second');
    const result = deferred<{ secretRef: string; accountScope: string }>();
    oauth.connection.mockImplementationOnce(() => result.promise);
    await login.start('first'); await login.start('second');
    oauth.statuses.set('first', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(1000);
    login.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(oauth.status('second').status).toBe('cancelled');
    state.storage.close();
    result.resolve({ secretRef: 'late-ref', accountScope: 'late-account' });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(login.start('first')).rejects.toThrow('登录服务已关闭');
  });

  it('cancels an OAuth attempt whose creation finishes after close', async () => {
    const opening = deferred<{ url: string }>();
    oauth.start.mockImplementationOnce(() => opening.promise);
    const result = login.start('first');
    const cancelled = expect(result).rejects.toThrow('登录已取消');
    await Promise.resolve(); await Promise.resolve();
    login.close(); state.storage.close();
    opening.resolve({ url: 'https://example.test/late' });
    await cancelled;
    expect(oauth.cancel.mock.calls.filter(([id]) => id === 'first')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
