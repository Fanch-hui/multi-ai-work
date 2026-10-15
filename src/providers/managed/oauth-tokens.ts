import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { AuthenticationRequiredError } from '../../domain/provider.js';
import { providerFetch } from '../network.js';

export const OAUTH_ISSUER = 'https://auth.openai.com';
export const OAUTH_RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_ENDPOINT = `${OAUTH_ISSUER}/api/accounts/oauth/token`;
export interface OAuthTokens {
  client_id: string; subject: string; issuer: string; ext_agent_host_id: string;
  access_token: string; refresh_token?: string; id_token: string; token_type: string;
  scopes: string[]; expires_at: number; earliest_refresh_at?: number;
}
const jwks = createRemoteJWKSet(new URL(`${OAUTH_ISSUER}/.well-known/jwks.json`), { [customFetch]: providerFetch });
const refreshes = new Map<string, Promise<OAuthTokens>>();
const invalidAuthorizationCodes = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
class OAuthExchangeUnavailableError extends Error {}

async function waitForRefresh(operation: Promise<OAuthTokens>, signal?: AbortSignal): Promise<OAuthTokens> {
  signal?.throwIfAborted();
  if (!signal) return operation;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', cancel); }
}

export function accountScope(record: Pick<OAuthTokens, 'client_id' | 'subject'>): string {
  return `openai:${createHash('sha256').update(`${record.client_id}:${record.subject}`).digest('hex')}`;
}
export function parseTokens(value?: string): OAuthTokens {
  if (!value) throw new Error('请先使用 ChatGPT 登录');
  let record: OAuthTokens;
  try { record = JSON.parse(value); } catch { throw new Error('ChatGPT 凭据格式无效，请重新登录'); }
  if (!record || typeof record !== 'object' || typeof record.access_token !== 'string' || !record.access_token || typeof record.client_id !== 'string'
    || !record.client_id || record.client_id === 'dynamic_agent_client' || typeof record.subject !== 'string' || !record.subject
    || typeof record.id_token !== 'string' || !record.id_token || record.token_type !== 'Bearer' || !Array.isArray(record.scopes)
    || record.issuer !== OAUTH_ISSUER || !Number.isFinite(record.expires_at)) {
    throw new Error('ChatGPT 凭据无效，请重新登录');
  }
  if (!record.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('登录未授予 ChatGPT 用量权限');
  return record;
}
export async function revokeTokens(record: OAuthTokens): Promise<boolean> {
  if (!record.refresh_token) return true;
  try {
    const discovery = await providerFetch(`${OAUTH_ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!discovery.ok) return false;
    const configuration = await discovery.json() as { issuer?: string; revocation_endpoint?: string };
    if (configuration.issuer !== OAUTH_ISSUER || !configuration.revocation_endpoint) return false;
    const revokeUrl = new URL(configuration.revocation_endpoint);
    if (revokeUrl.origin !== OAUTH_ISSUER) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await providerFetch(revokeUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: record.refresh_token, token_type_hint: 'refresh_token', client_id: record.client_id }),
      });
      if (response.status === 200) return true;
      if (response.status < 500) return false;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch { return false; }
  return false;
}
export async function verifyIdentity(idToken: string, clientId: string, nonce?: string) {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: OAUTH_ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
  });
  if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new Error('ChatGPT 登录身份验证失败');
  return payload;
}
export async function exchangeTokens(form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await providerFetch(TOKEN_ENDPOINT, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...form, resource: OAUTH_RESOURCE }),
  }).catch(error => {
    if (signal?.aborted) throw error;
    throw new OAuthExchangeUnavailableError(error instanceof Error ? error.message : 'ChatGPT 授权服务连接失败，请稍后重试或检查网络');
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => undefined) as { error?: string | { code?: string } } | undefined;
    const code = typeof failure?.error === 'string' ? failure.error : failure?.error?.code;
    if (code && invalidAuthorizationCodes.has(code)) throw new AuthenticationRequiredError(`ChatGPT 登录授权已失效（HTTP ${response.status}，${code}），请重新登录`);
    if (code === 'invalid_client') throw new Error(`ChatGPT 登录客户端配置无效（HTTP ${response.status}，invalid_client），请检查连接配置`);
    if (response.status === 403) throw new OAuthExchangeUnavailableError('ChatGPT 授权服务器拒绝请求（HTTP 403），请检查网络或授权服务的访问限制后重试');
    const message = `ChatGPT 授权交换失败（HTTP ${response.status}），请稍后重试或检查网络`;
    if ([408, 429].includes(response.status) || response.status >= 500) throw new OAuthExchangeUnavailableError(message);
    throw new Error(message);
  }
  return await response.json() as Record<string, unknown>;
}
export function mergeTokens(raw: Record<string, unknown>, identity: Omit<OAuthTokens, 'access_token' | 'token_type' | 'scopes' | 'expires_at'>, old?: OAuthTokens): OAuthTokens {
  if (typeof raw.access_token !== 'string' || raw.token_type !== 'Bearer'
    || typeof raw.expires_in !== 'number' || raw.expires_in <= 0) throw new Error('ChatGPT 授权返回无效');
  const scopes = typeof raw.scope === 'string' ? raw.scope.split(/\s+/) : old?.scopes ?? [];
  if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('登录未授予 ChatGPT 用量权限');
  return { ...identity, access_token: raw.access_token, token_type: 'Bearer', scopes,
    refresh_token: typeof raw.refresh_token === 'string' ? raw.refresh_token : old?.refresh_token,
    expires_at: Date.now() + raw.expires_in * 1000,
    earliest_refresh_at: typeof raw.earliest_refresh_at === 'number' ? raw.earliest_refresh_at * 1000 : undefined };
}
export async function getOAuthAccessToken(ref: string | undefined, get: (ref?: string) => Promise<string | undefined>,
  save?: (ref: string, value: string) => Promise<void>, signal?: AbortSignal, rejectedAccessToken?: string): Promise<OAuthTokens> {
  signal?.throwIfAborted();
  while (ref) {
    const pending = refreshes.get(ref);
    if (!pending) break;
    const record = await waitForRefresh(pending, signal);
    if (!rejectedAccessToken || record.access_token !== rejectedAccessToken) return record;
  }
  // Persist connection credential rotation even when its original caller stops waiting.
  const operation = (async () => {
    const record = parseTokens(await get(ref));
    const rejected = record.access_token === rejectedAccessToken;
    if (!rejected && record.expires_at > Date.now() + 60_000) return record;
    if (!ref || !save || !record.refresh_token) throw new AuthenticationRequiredError('ChatGPT 登录已到期，请重新登录');
    if (record.earliest_refresh_at && record.earliest_refresh_at > Date.now()) {
      if (!rejected && record.expires_at > Date.now()) return record;
      throw new Error('ChatGPT 暂时无法刷新，请稍后重试');
    }
    let raw: Record<string, unknown>;
    try {
      raw = await exchangeTokens({ grant_type: 'refresh_token', client_id: record.client_id, refresh_token: record.refresh_token! });
    } catch (error) {
      if (rejected || !(error instanceof OAuthExchangeUnavailableError) || record.expires_at <= Date.now()) throw error;
      return record;
    }
    let idToken = record.id_token;
    if (typeof raw.id_token === 'string') {
      const identity = await verifyIdentity(raw.id_token, record.client_id);
      if (identity.sub !== record.subject) throw new Error('ChatGPT 刷新身份不匹配');
      idToken = raw.id_token;
    }
    const next = mergeTokens(raw, { ...record, id_token: idToken }, record);
    await save(ref, JSON.stringify(next));
    return next;
  })().finally(() => { if (ref && refreshes.get(ref) === operation) refreshes.delete(ref); });
  if (ref) refreshes.set(ref, operation);
  return waitForRefresh(operation, signal);
}
