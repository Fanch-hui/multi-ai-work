import type { Connection } from '../domain/types.js';
import type { OAuthManager, OAuthStatus } from '../security/oauth.js';
import { publicError, required } from './errors.js';
import type { State } from './state.js';

interface LoginAttempt {
  revision?: number;
  timer?: NodeJS.Timeout;
}
type LoginOAuth = Pick<OAuthManager, 'start' | 'status' | 'connection' | 'cancel'>;

export class ConnectionLogin {
  private attempts = new Map<string, LoginAttempt>();
  private starts = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(
    private state: State,
    private oauth: LoginOAuth,
  ) {}

  start(connectionId: string): Promise<{ url: string }> {
    if (this.closed) return Promise.reject(new Error('登录服务已关闭'));
    this.cancel(connectionId);
    const attempt: LoginAttempt = {};
    this.attempts.set(connectionId, attempt);
    const pending = (this.starts.get(connectionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.create(connectionId, attempt));
    this.starts.set(connectionId, pending);
    void pending.then(
      () => this.releaseStart(connectionId, pending),
      () => this.releaseStart(connectionId, pending),
    );
    return pending;
  }

  cancel(connectionId: string): void {
    const attempt = this.attempts.get(connectionId);
    if (attempt?.timer) clearInterval(attempt.timer);
    this.attempts.delete(connectionId);
    this.oauth.cancel(connectionId);
  }

  close(): void {
    this.closed = true;
    for (const connectionId of this.attempts.keys()) this.cancel(connectionId);
  }

  private active(connectionId: string, attempt: LoginAttempt): boolean {
    return !this.closed && this.attempts.get(connectionId) === attempt;
  }

  private releaseStart(connectionId: string, pending: Promise<unknown>): void {
    if (this.starts.get(connectionId) === pending) this.starts.delete(connectionId);
  }

  private async create(connectionId: string, attempt: LoginAttempt): Promise<{ url: string }> {
    if (!this.active(connectionId, attempt)) throw new Error('登录已取消');
    try {
      const connection = required(
        this.state.storage.get<Connection>('connections', connectionId),
        '连接不存在',
      );
      if (connection.provider !== 'chatgpt') throw new Error('连接不支持 ChatGPT 登录');
      attempt.revision = connection.revision + 1;
      this.state.storage.put('connections', {
        ...connection,
        revision: attempt.revision,
        status: 'needs_auth',
        error: undefined,
      });
      this.state.changed();
      const result = await this.oauth.start(connectionId);
      if (!this.active(connectionId, attempt)) {
        this.oauth.cancel(connectionId);
        throw new Error('登录已取消');
      }
      attempt.timer = setInterval(() => this.poll(connectionId, attempt), 1000);
      attempt.timer.unref();
      return result;
    } catch (error) {
      this.save(connectionId, attempt, { status: 'needs_auth', error: publicError(error) });
      if (this.active(connectionId, attempt)) this.attempts.delete(connectionId);
      throw error;
    }
  }

  private poll(connectionId: string, attempt: LoginAttempt): void {
    if (!this.active(connectionId, attempt)) return;
    const status = this.oauth.status(connectionId);
    if (status.status === 'pending') return;
    clearInterval(attempt.timer);
    attempt.timer = undefined;
    void this.complete(connectionId, attempt, status);
  }

  private async complete(
    connectionId: string,
    attempt: LoginAttempt,
    status: OAuthStatus,
  ): Promise<void> {
    try {
      if (status.status === 'completed') {
        const auth = await this.oauth.connection(connectionId);
        this.save(connectionId, attempt, { ...auth, status: 'untested', error: undefined });
      } else
        this.save(connectionId, attempt, {
          status: 'needs_auth',
          error: status.error ? publicError(status.error) : undefined,
        });
    } catch (error) {
      this.save(connectionId, attempt, { status: 'needs_auth', error: publicError(error) });
    } finally {
      if (this.active(connectionId, attempt)) this.attempts.delete(connectionId);
    }
  }

  private save(connectionId: string, attempt: LoginAttempt, update: Partial<Connection>): void {
    if (!this.active(connectionId, attempt)) return;
    const current = this.state.storage.get<Connection>('connections', connectionId);
    if (!current || current.provider !== 'chatgpt' || current.revision !== attempt.revision) return;
    this.state.storage.put('connections', { ...current, ...update });
    this.state.changed();
  }
}
