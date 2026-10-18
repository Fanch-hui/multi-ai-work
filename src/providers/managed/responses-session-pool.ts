import type { ProviderSocket } from '../network.js';

export interface ResponsesSession {
  socket?: ProviderSocket;
  identity?: string;
  previous?: { id: string; settings: string; items: string[] };
  closed?: boolean;
}

export function resetResponsesSession(session: ResponsesSession): void {
  session.previous = undefined;
  session.identity = undefined;
  const socket = session.socket;
  session.socket = undefined;
  socket?.close();
}

/** Retains transport state only; request contexts and cancellation stay with each lease. */
export class ResponsesSessionPool {
  private idle = new Map<string, { session: ResponsesSession; expires: number }>();
  private active = new Set<ResponsesSession>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private maxIdle = 16, private idleTtlMs = 5 * 60_000) {}

  acquire(key: string): ResponsesSession {
    if (this.closed) throw new Error('模型会话池已关闭');
    this.expire();
    const session = this.idle.get(key)?.session ?? {};
    this.idle.delete(key);
    this.active.add(session);
    this.schedule();
    return session;
  }

  release(key: string, session: ResponsesSession): void {
    if (!this.active.delete(session)) return;
    if (this.closed || session.closed || session.socket?.readyState !== 1) {
      resetResponsesSession(session);
      return;
    }
    this.remove(key);
    this.idle.set(key, { session, expires: Date.now() + this.idleTtlMs });
    while (this.idle.size > this.maxIdle) this.remove(this.idle.keys().next().value!);
    this.schedule();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of this.idle.keys()) this.remove(key);
    for (const session of this.active) {
      session.closed = true;
      resetResponsesSession(session);
    }
    this.active.clear();
  }

  private remove(key: string): void {
    const value = this.idle.get(key);
    this.idle.delete(key);
    if (value) resetResponsesSession(value.session);
  }

  private expire(): void {
    for (const [key, value] of this.idle) if (value.expires <= Date.now()) this.remove(key);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const first = this.idle.values().next().value;
    this.timer = first ? setTimeout(() => { this.expire(); this.schedule(); }, Math.max(1, first.expires - Date.now())) : undefined;
    this.timer?.unref();
  }
}
