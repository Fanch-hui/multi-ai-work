import type { RunContext } from '../../domain/provider.js';
import { providerFetch } from '../network.js';
import { createClient, endpoint, ProviderAuthorizationError } from './client.js';
import { accountScope, getOAuthAccessToken } from './oauth-tokens.js';

export function createOAuthClient(context: RunContext) {
  const authorize = async (rejectedAccessToken?: string) => {
    try {
      const record = await getOAuthAccessToken(context.connection.secretRef, context.getSecret,
        context.saveSecret, context.signal, rejectedAccessToken);
      if (context.binding.accountScope && context.binding.accountScope !== accountScope(record)) {
        throw new Error('会话绑定的 ChatGPT 账号已变化');
      }
      return record.access_token;
    } catch (error) {
      throw new ProviderAuthorizationError(error instanceof Error ? error : new Error('ChatGPT 授权失败'));
    }
  };
  return createClient(endpoint(context.connection), undefined, async (input, init) => {
    const headers = new Headers(init?.headers);
    const accessToken = await authorize();
    headers.set('authorization', `Bearer ${accessToken}`);
    const request = () => providerFetch(input, { ...init, headers });
    const response = await request();
    if (response.status !== 401) return response;
    const failure = await response.clone().json().catch(() => undefined) as { error?: { code?: string } } | undefined;
    if (failure?.error?.code !== 'token_expired') return response;
    // HTTP rejection occurs before SSE starts, so only this request is retried.
    await response.body?.cancel();
    headers.set('authorization', `Bearer ${await authorize(accessToken)}`);
    return request();
  });
}
