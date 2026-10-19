import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  accountScope,
  exchangeTokens,
  mergeTokens,
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  parseTokens,
  revokeTokens,
  verifyIdentity,
} from '../providers/managed/oauth-tokens.js';

interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}
interface Metadata {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}
interface Attempt {
  server: Server;
  timer: NodeJS.Timeout;
  controller: AbortController;
}
export interface OAuthStatus {
  status: 'idle' | 'pending' | 'completed' | 'error' | 'cancelled';
  error?: string;
}
const randomValue = () => randomBytes(32).toString('base64url');
const reference = (id: string) => `chatgpt:${id}`;
interface Registration {
  client_id: string;
  subject: string;
  id_token?: string;
}

export class OAuthManager {
  private attempts = new Map<string, Attempt>();
  private statuses = new Map<string, OAuthStatus>();
  constructor(
    private store: SecretStore,
    private metadata: Metadata,
  ) {}

  status(connectionId: string): OAuthStatus {
    return this.statuses.get(connectionId) ?? { status: 'idle' };
  }
  async connection(connectionId: string): Promise<{ secretRef: string; accountScope: string }> {
    const record = parseTokens(await this.store.get(reference(connectionId)));
    return { secretRef: reference(connectionId), accountScope: accountScope(record) };
  }
  cancel(connectionId: string): void {
    const attempt = this.attempts.get(connectionId);
    if (attempt) {
      attempt.controller.abort();
      clearTimeout(attempt.timer);
      attempt.server.close();
      this.attempts.delete(connectionId);
    }
    this.statuses.set(connectionId, { status: 'cancelled' });
  }
  close(): void {
    for (const id of this.attempts.keys()) this.cancel(id);
  }
  async signOut(connectionId: string): Promise<{ remoteRevocationConfirmed: boolean }> {
    this.cancel(connectionId);
    const value = await this.store.get(reference(connectionId));
    const record = value ? parseTokens(value) : undefined;
    const remoteRevocationConfirmed = record ? await revokeTokens(record) : true;
    if (record)
      await this.store.set(
        `chatgpt-registration:${connectionId}`,
        JSON.stringify({ client_id: record.client_id, subject: record.subject }),
      );
    await this.store.delete(reference(connectionId));
    this.statuses.set(connectionId, { status: 'idle' });
    return { remoteRevocationConfirmed };
  }
  async start(connectionId: string): Promise<{ url: string }> {
    this.cancel(connectionId);
    const oldValue = await this.store.get(reference(connectionId));
    const registration = await this.store.get(`chatgpt-registration:${connectionId}`);
    let old: Registration | undefined;
    if (oldValue) old = parseTokens(oldValue);
    else if (registration) old = JSON.parse(registration);
    let host = this.metadata.get('oauth.hostId');
    if (typeof host !== 'string') {
      host = `urn:uuid:${randomUUID()}`;
      this.metadata.set('oauth.hostId', host);
    }
    const state = randomValue(),
      nonce = randomValue(),
      verifier = randomValue();
    const controller = new AbortController();
    let consumed = false,
      redirectUri = '';
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? '/', redirectUri);
      if (request.method !== 'GET' || callback.pathname !== '/auth/callback') {
        response.writeHead(404).end();
        return;
      }
      const returnedState = callback.searchParams.get('state') ?? '';
      if (consumed || !sameState(state, returnedState)) {
        response.writeHead(400).end('Invalid sign-in state.');
        return;
      }
      consumed = true;
      void this.complete(
        connectionId,
        callback,
        old,
        verifier,
        nonce,
        redirectUri,
        host as string,
        controller.signal,
      )
        .then(() => {
          if (!controller.signal.aborted) this.statuses.set(connectionId, { status: 'completed' });
          response
            .writeHead(200, pageHeaders)
            .end('登录成功。可以关闭此窗口并返回 multi-AI work。');
        })
        .catch(() => {
          if (!controller.signal.aborted)
            this.statuses.set(connectionId, {
              status: 'error',
              error: '登录失败或未授予权限，请重试',
            });
          response.writeHead(400, pageHeaders).end('登录未完成。请返回 multi-AI work 重新登录。');
        })
        .finally(() => {
          const attempt = this.attempts.get(connectionId);
          if (attempt?.server === server) {
            clearTimeout(attempt.timer);
            this.attempts.delete(connectionId);
          }
          server.close();
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('登录回调无法启动');
    }
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const timer = setTimeout(() => {
      this.cancel(connectionId);
      this.statuses.set(connectionId, { status: 'error', error: '登录已超时，请重试' });
    }, 10 * 60_000);
    timer.unref();
    this.attempts.set(connectionId, { server, timer, controller });
    this.statuses.set(connectionId, { status: 'pending' });
    const url = new URL(`${OAUTH_ISSUER}/api/accounts/authorize`);
    let loginHint: Record<string, string> = {};
    if (!old) loginHint = { agent_name_hint: 'multi-AI work' };
    else if (old.id_token) loginHint = { id_token_hint: old.id_token };
    url.search = new URLSearchParams({
      client_id: old?.client_id ?? 'dynamic_agent_client',
      ext_agent_host_id: host as string,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: OAUTH_RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...loginHint,
    }).toString();
    return { url: url.toString() };
  }
  private async complete(
    id: string,
    callback: URL,
    old: Registration | undefined,
    verifier: string,
    nonce: string,
    redirectUri: string,
    host: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (callback.searchParams.has('error')) throw new Error('登录被取消');
    const code = callback.searchParams.get('code');
    const clientId = callback.searchParams.get('client_id') ?? old?.client_id;
    if (
      !code ||
      !clientId ||
      clientId === 'dynamic_agent_client' ||
      (old && clientId !== old.client_id)
    )
      throw new Error('注册未完成');
    const raw = await exchangeTokens(
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      },
      signal,
    );
    if (typeof raw.id_token !== 'string') throw new Error('登录缺少身份凭据');
    const identity = await verifyIdentity(raw.id_token, clientId, nonce);
    if (old && identity.sub !== old.subject) throw new Error('登录账号不匹配');
    const record = mergeTokens(raw, {
      client_id: clientId,
      subject: identity.sub!,
      issuer: OAUTH_ISSUER,
      ext_agent_host_id: host,
      id_token: raw.id_token,
    });
    signal.throwIfAborted();
    await this.store.set(reference(id), JSON.stringify(record));
  }
}
const pageHeaders = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};
function sameState(expected: string, actual: string): boolean {
  const first = Buffer.from(expected),
    second = Buffer.from(actual);
  return first.length === second.length && timingSafeEqual(first, second);
}
