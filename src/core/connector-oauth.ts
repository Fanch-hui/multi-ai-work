import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { ToolConnection } from '../domain/types.js';
import type { Vault } from '../security/vault.js';
import { providerFetch } from '../providers/network.js';
import { toolConfiguration } from '../domain/tool-connection.js';
import {
  ConnectorOAuthProvider,
  ConnectorOAuthStore,
  type ConnectorOAuthFlow,
} from './connector-oauth-provider.js';
import { publicError, required } from './errors.js';
import type { State } from './state.js';

export interface ConnectorOAuthStatus {
  enabled: boolean;
  phase: 'disconnected' | 'authorizing' | 'awaiting_user' | 'connected' | 'error';
  expiresAt?: number;
  error?: string;
}
interface PendingLogin {
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  state: string;
  path: string;
  consumed: boolean;
  abort: AbortController;
}
type OAuthOptions = { openExternal?: (url: string) => Promise<unknown>; fetch?: typeof fetch };

export class ConnectorOAuth {
  onAuthorized?: (id: string) => Promise<unknown>;
  private store: ConnectorOAuthStore;
  private logins = new Map<string, PendingLogin>();
  private starting = new Map<string, Promise<ConnectorOAuthStatus>>();
  private statuses = new Map<string, ConnectorOAuthStatus>();
  private epochs = new Map<string, symbol>();
  private closed = false;
  readonly fetch: typeof fetch;
  constructor(
    private state: State,
    vault: Vault,
    private options: OAuthOptions = {},
  ) {
    this.store = new ConnectorOAuthStore(vault);
    this.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.username ||
        url.password ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      )
        throw new Error('连接器授权与凭据请求需要 HTTPS 或本机回环地址');
      return (this.options.fetch ?? providerFetch)(input, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      });
    };
  }

  provider(connection: ToolConnection): OAuthClientProvider | undefined {
    if (
      !this.enabled(connection.id) ||
      connection.kind === 'search' ||
      connection.transport === 'stdio'
    )
      return undefined;
    return this.createProvider(connection);
  }

  async status(id: string): Promise<ConnectorOAuthStatus> {
    const active = this.statuses.get(id);
    if (active && active.phase !== 'connected') return active;
    const connection = this.connection(id);
    if (!this.enabled(id)) return { enabled: false, phase: 'disconnected' };
    const record = await this.store.read(this.ref(connection));
    return {
      enabled: true,
      phase: record.tokens ? 'connected' : 'disconnected',
      expiresAt: record.expiresAt,
    };
  }

  login(
    id: string,
    input: { clientId?: string; issuer?: string } = {},
  ): Promise<ConnectorOAuthStatus> {
    const existing = this.starting.get(id);
    if (existing) return existing;
    const pending = this.beginLogin(id, input).finally(() => {
      if (this.starting.get(id) === pending) this.starting.delete(id);
    });
    this.starting.set(id, pending);
    return pending;
  }

  private async beginLogin(
    id: string,
    input: { clientId?: string; issuer?: string } = {},
  ): Promise<ConnectorOAuthStatus> {
    if (this.closed) throw new Error('连接器授权服务已关闭');
    if (!this.options.openExternal) throw new Error('登录授权需要桌面浏览器');
    if (this.logins.has(id)) return this.status(id);
    const connection = this.connection(id);
    if (connection.kind === 'search' || connection.transport === 'stdio')
      throw new Error('浏览器登录适用于 HTTP MCP 连接');
    this.fetchUrl(connection.url!);
    const epoch = await this.reset(id);
    if (this.closed || this.epochs.get(id) !== epoch) throw new Error('授权已取消');
    this.state.storage.setMetadata(`connector-oauth-enabled:${id}`, true);
    this.state.storage.setMetadata(`connector-oauth-ref:${id}`, this.ref(connection));
    const randomState = randomBytes(32).toString('base64url');
    const path = `/oauth/callback/${randomBytes(16).toString('hex')}`;
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (this.closed || this.epochs.get(id) !== epoch) {
      server.close();
      throw new Error('授权已取消');
    }
    if (!address || typeof address === 'string') throw new Error('无法创建本机授权回调');
    const redirectUrl = `http://127.0.0.1:${address.port}${path}`;
    const pending: PendingLogin = {
      server,
      state: randomState,
      path,
      consumed: false,
      abort: new AbortController(),
      timer: setTimeout(() => {
        if (this.epochs.get(id) === epoch) this.fail(id, '授权已超时，请重新登录');
      }, 10 * 60_000),
    };
    pending.timer.unref();
    this.logins.set(id, pending);
    this.setStatus(id, { enabled: true, phase: 'authorizing' });
    const flow: ConnectorOAuthFlow = {
      redirectUrl,
      state: randomState,
      redirect: async (url) => {
        this.fetchUrl(url.href);
        if (
          url.searchParams.get('state') !== randomState ||
          url.searchParams.get('code_challenge_method') !== 'S256'
        )
          throw new Error('授权请求缺少安全校验');
        await this.options.openExternal!(url.href);
        if (this.epochs.get(id) !== epoch) throw new Error('授权已取消');
        this.setStatus(id, { enabled: true, phase: 'awaiting_user' });
      },
    };
    const provider = this.createProvider(connection, flow);
    const fetcher: typeof fetch = (url, init) =>
      this.fetch(url, { ...init, signal: pending.abort.signal });
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUrl);
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const received = url.searchParams.get('state') ?? '';
      const sameState =
        Buffer.byteLength(received) === Buffer.byteLength(randomState) &&
        timingSafeEqual(Buffer.from(received), Buffer.from(randomState));
      if (
        request.method !== 'GET' ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        url.pathname !== path ||
        url.searchParams.getAll('state').length !== 1 ||
        !sameState ||
        pending.consumed
      ) {
        response.writeHead(400).end('授权回调无效，请返回应用重新登录。');
        return;
      }
      pending.consumed = true;
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) {
        response.writeHead(400).end('授权未完成，请返回应用。');
        this.fail(id, '授权未完成，请重新登录');
        return;
      }
      void auth(provider, { serverUrl: connection.url!, authorizationCode: code, fetchFn: fetcher })
        .then(async (result) => {
          if (result !== 'AUTHORIZED' || this.epochs.get(id) !== epoch)
            throw new Error('授权已取消');
          await this.finish(id);
          await this.onAuthorized?.(id);
          const record = await this.store.read(this.ref(connection));
          this.setStatus(id, { enabled: true, phase: 'connected', expiresAt: record.expiresAt });
          response.writeHead(200).end('登录成功，可以返回 multi-AI work。');
        })
        .catch((error) => {
          response.writeHead(400).end('授权未完成，请返回应用检查连接。');
          if (this.epochs.get(id) === epoch) this.fail(id, publicError(error));
        });
    });
    try {
      if (input.clientId) {
        if (!input.issuer) throw new Error('预注册客户端需要填写授权服务器地址');
        this.fetchUrl(input.issuer);
        await this.store.update(this.ref(connection), (record) => ({
          ...record,
          redirectUrl,
          client: { client_id: input.clientId!, issuer: input.issuer },
        }));
      }
      const result = await auth(provider, { serverUrl: connection.url!, fetchFn: fetcher });
      if (result === 'AUTHORIZED') {
        await this.finish(id);
        await this.onAuthorized?.(id);
        this.setStatus(id, { enabled: true, phase: 'connected' });
      }
      return this.status(id);
    } catch (error) {
      if (this.epochs.get(id) === epoch) this.fail(id, publicError(error));
      throw error;
    }
  }

  async logout(id: string) {
    this.connection(id);
    await this.reset(id);
    return this.status(id);
  }
  async prepareRestore() {
    const ids = new Set([
      ...this.state.storage
        .all<ToolConnection>('tool_connections')
        .map((connection) => connection.id),
      ...this.logins.keys(),
    ]);
    for (const id of ids) await this.reset(id);
  }
  async finishRestore() {
    this.statuses.clear();
    for (const connection of this.state.storage.all<ToolConnection>('tool_connections'))
      await this.reset(connection.id);
  }
  async reset(id: string) {
    const epoch = Symbol();
    this.epochs.set(id, epoch);
    await this.finish(id);
    const ref = this.state.storage.metadata<string>(`connector-oauth-ref:${id}`);
    const prefix = `connector-oauth:${id}:`;
    if (ref?.startsWith(prefix) && /^[a-f0-9]{64}$/.test(ref.slice(prefix.length)))
      await this.store.remove(ref);
    this.state.storage.setMetadata(`connector-oauth-enabled:${id}`, false);
    this.state.storage.setMetadata(`connector-oauth-ref:${id}`, null);
    const revision = this.state.storage.metadata<number>(`connector-account-revision:${id}`) ?? 0;
    this.state.storage.setMetadata(`connector-account-revision:${id}`, revision + 1);
    this.statuses.delete(id);
    this.state.changed();
    return epoch;
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.logins.keys()].map((id) => this.finish(id)));
  }

  private createProvider(connection: ToolConnection, flow?: ConnectorOAuthFlow) {
    const configuration = toolConfiguration(connection),
      epoch = this.epochs.get(connection.id);
    return new ConnectorOAuthProvider(
      this.store,
      this.ref(connection),
      this.fetch,
      () => {
        if (
          this.closed ||
          this.epochs.get(connection.id) !== epoch ||
          toolConfiguration(this.connection(connection.id)) !== configuration ||
          !this.enabled(connection.id)
        )
          throw new Error('连接器授权配置已更改');
      },
      flow,
    );
  }
  private connection(id: string) {
    return required(this.state.storage.get<ToolConnection>('tool_connections', id), '连接器不存在');
  }
  private ref(connection: ToolConnection) {
    return `connector-oauth:${connection.id}:${createHash('sha256')
      .update(connection.url ?? '')
      .digest('hex')}`;
  }
  private enabled(id: string) {
    return this.state.storage.metadata<boolean>(`connector-oauth-enabled:${id}`) === true;
  }
  private fetchUrl(value: string) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    )
      throw new Error('授权地址需要 HTTPS 或本机回环地址');
  }
  private setStatus(id: string, status: ConnectorOAuthStatus) {
    this.statuses.set(id, status);
    this.state.changed();
  }
  private fail(id: string, error: string) {
    void this.finish(id);
    this.setStatus(id, { enabled: true, phase: 'error', error });
  }
  private async finish(id: string) {
    const pending = this.logins.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.abort.abort();
    this.logins.delete(id);
    pending.server.close();
    pending.server.closeIdleConnections();
  }
}
