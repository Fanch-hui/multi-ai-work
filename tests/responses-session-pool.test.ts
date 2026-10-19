import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSocket } from '../src/providers/network.js';
import {
  ResponsesSessionPool,
  type ResponsesSession,
} from '../src/providers/managed/responses-session-pool.js';

function connect(session: ResponsesSession) {
  const close = vi.fn();
  session.socket = { readyState: 1, close } as unknown as ProviderSocket;
  return close;
}
afterEach(() => vi.useRealTimers());

describe('Responses session pool', () => {
  it('retains at most 16 idle sessions without evicting an active request', () => {
    const pool = new ResponsesSessionPool();
    const active = pool.acquire('active'),
      closeActive = connect(active);
    const first = pool.acquire('first'),
      closeFirst = connect(first);
    pool.release('first', first);
    for (let i = 0; i < 16; i++) {
      const session = pool.acquire(String(i));
      connect(session);
      pool.release(String(i), session);
    }
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeActive).not.toHaveBeenCalled();
    pool.close();
    expect(closeActive).toHaveBeenCalledOnce();
  });

  it('expires idle sockets after five minutes while leaving active requests alone', () => {
    vi.useFakeTimers();
    const pool = new ResponsesSessionPool();
    const active = pool.acquire('active'),
      closeActive = connect(active);
    const idle = pool.acquire('idle'),
      closeIdle = connect(idle);
    pool.release('idle', idle);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(closeIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closeIdle).toHaveBeenCalledOnce();
    expect(closeActive).not.toHaveBeenCalled();
    expect(pool.acquire('idle')).not.toBe(idle);
    pool.close();
  });

  it('returns fresh state for a nested checkout and closes superseded idle state', () => {
    const pool = new ResponsesSessionPool();
    const outer = pool.acquire('same'),
      closeOuter = connect(outer);
    const nested = pool.acquire('same'),
      closeNested = connect(nested);
    expect(nested).not.toBe(outer);
    pool.release('same', nested);
    pool.release('same', outer);
    expect(closeNested).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
    expect(pool.acquire('same')).toBe(outer);
    pool.close();
    expect(closeOuter).toHaveBeenCalledOnce();
  });

  it('closes all leases and rejects acquisition after shutdown', () => {
    const pool = new ResponsesSessionPool();
    const session = pool.acquire('active'),
      close = connect(session);
    pool.close();
    pool.release('active', session);
    expect(close).toHaveBeenCalledOnce();
    expect(session.closed).toBe(true);
    expect(() => pool.acquire('new')).toThrow('已关闭');
  });
});
