import {
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Vault } from '../security/vault.js';

export interface ConnectorOAuthRecord {
  redirectUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
}
export interface ConnectorOAuthFlow {
  redirectUrl: string;
  state: string;
  verifier?: string;
  redirect(url: URL): Promise<void>;
}

export class ConnectorOAuthStore {
  private queues = new Map<string, Promise<void>>();
  private refreshes = new Map<string, Promise<OAuthTokens | undefined>>();
  constructor(private vault: Vault) {}
  async read(ref: string): Promise<ConnectorOAuthRecord> {
    const value = await this.vault.get(ref);
    return value ? (JSON.parse(value) as ConnectorOAuthRecord) : {};
  }
  update(
    ref: string,
    change: (record: ConnectorOAuthRecord) => ConnectorOAuthRecord,
  ): Promise<void> {
    const operation = (this.queues.get(ref) ?? Promise.resolve()).then(async () => {
      await this.vault.set(ref, JSON.stringify(change(await this.read(ref))));
    });
    const tail = operation.catch(() => {});
    this.queues.set(ref, tail);
    void tail.then(() => {
      if (this.queues.get(ref) === tail) this.queues.delete(ref);
    });
    return operation;
  }
  async remove(ref: string) {
    await this.queues.get(ref);
    await this.vault.delete(ref);
  }
  refresh(ref: string, action: () => Promise<OAuthTokens | undefined>) {
    let pending = this.refreshes.get(ref);
    if (!pending) {
      pending = action().finally(() => this.refreshes.delete(ref));
      this.refreshes.set(ref, pending);
    }
    return pending;
  }
}

export class ConnectorOAuthProvider implements OAuthClientProvider {
  private record: ConnectorOAuthRecord = {};
  constructor(
    private store: ConnectorOAuthStore,
    private ref: string,
    private fetcher: typeof fetch,
    private assertCurrent: () => void,
    private flow?: ConnectorOAuthFlow,
  ) {}

  get redirectUrl() {
    return this.flow?.redirectUrl ?? this.record.redirectUrl ?? 'http://127.0.0.1/oauth/callback';
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'multi-AI work',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    if (!this.flow) throw new Error('请在连接器中点击登录授权');
    return this.flow.state;
  }
  async clientInformation() {
    await this.load();
    if (!this.record.client && !this.flow) throw new Error('请在连接器中点击登录授权');
    return this.record.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    await this.update((record) => ({
      ...record,
      client: OAuthClientInformationSchema.parse(client),
      redirectUrl: this.redirectUrl,
    }));
  }
  async tokens(): Promise<OAuthTokens | undefined> {
    await this.load();
    const record = this.record;
    if (!record.tokens || !record.expiresAt || record.expiresAt > Date.now() + 30_000 || this.flow)
      return record.tokens;
    return this.store.refresh(this.ref, async () => {
      await this.load();
      const current = this.record;
      if (!current.expiresAt || current.expiresAt > Date.now() + 30_000) return current.tokens;
      if (!current.tokens?.refresh_token || !current.client || !current.discovery)
        throw new Error('连接器登录已到期，请重新登录授权');
      const tokens = await refreshAuthorization(current.discovery.authorizationServerUrl, {
        metadata: current.discovery.authorizationServerMetadata,
        clientInformation: current.client,
        refreshToken: current.tokens.refresh_token,
        resource: current.discovery.resourceMetadata?.resource,
        fetchFn: this.fetcher,
      });
      const next = { ...tokens, issuer: current.tokens.issuer };
      await this.saveTokens(next);
      return next;
    });
  }
  async saveTokens(tokens: OAuthTokens) {
    const parsed = OAuthTokensSchema.parse(tokens);
    await this.update((record) => ({
      ...record,
      tokens: {
        ...parsed,
        refresh_token: parsed.refresh_token ?? record.tokens?.refresh_token,
      },
      expiresAt:
        parsed.expires_in === undefined ? undefined : Date.now() + parsed.expires_in * 1000,
    }));
  }
  async redirectToAuthorization(url: URL) {
    this.assertCurrent();
    if (!this.flow) throw new Error('连接器需要重新授权，请在连接器中点击登录');
    await this.flow.redirect(url);
  }
  saveCodeVerifier(verifier: string) {
    if (!this.flow) throw new Error('请从连接器启动登录授权');
    this.flow.verifier = verifier;
  }
  codeVerifier() {
    if (!this.flow?.verifier) throw new Error('授权已过期，请重新登录');
    return this.flow.verifier;
  }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    const metadata = discovery.authorizationServerMetadata;
    if (!metadata?.code_challenge_methods_supported?.includes('S256'))
      throw new Error('授权服务器需要支持 PKCE S256');
    if (
      metadata.issuer &&
      new URL(metadata.issuer).href !== new URL(discovery.authorizationServerUrl).href
    )
      throw new Error('授权服务器身份与发现地址不一致');
    await this.update((record) => ({ ...record, discovery }));
  }
  async discoveryState() {
    await this.load();
    return this.record.discovery;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'verifier') {
      if (this.flow) this.flow.verifier = undefined;
      return;
    }
    await this.update((record) => {
      const next = { ...record };
      if (scope === 'all' || scope === 'client') delete next.client;
      if (scope === 'all' || scope === 'tokens') {
        delete next.tokens;
        delete next.expiresAt;
      }
      if (scope === 'all' || scope === 'discovery') delete next.discovery;
      return next;
    });
  }
  private async load() {
    this.assertCurrent();
    this.record = await this.store.read(this.ref);
    this.assertCurrent();
  }
  private async update(change: (record: ConnectorOAuthRecord) => ConnectorOAuthRecord) {
    this.assertCurrent();
    await this.store.update(this.ref, (record) => {
      this.assertCurrent();
      return change(record);
    });
    await this.load();
  }
}
