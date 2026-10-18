import type { ProviderAdapter, ProbeContext, RunContext } from '../../domain/provider.js';
import { createClient, capabilities, endpoint, modelCatalog, providerError } from './client.js';
import { getOAuthAccessToken, accountScope } from './oauth-tokens.js';
import { runManaged } from './loop.js';
import { createOAuthClient } from './oauth-client.js';
import { ChatReplayCompatibility } from './chat-replay-compatibility.js';

export class ChatGptAdapter implements ProviderAdapter {
  readonly kind = 'chatgpt' as const;
  async probe(context: ProbeContext) {
    const record = await getOAuthAccessToken(context.connection.secretRef, context.getSecret, context.saveSecret, context.signal);
    return { models: await modelCatalog(context, record.access_token, true), capabilities: capabilities(true), accountScope: accountScope(record) };
  }
  async run(context: RunContext) {
    try {
      return await runManaged(createOAuthClient(context), context, 'responses');
    }
    catch (error) { throw providerError(error); }
  }
}
export class CustomApiAdapter implements ProviderAdapter {
  readonly kind = 'custom' as const;
  private readonly chatReplay = new ChatReplayCompatibility();
  private protocol(context: ProbeContext | RunContext) {
    if (!context.connection.protocol) throw new Error('请选择 Chat Completions 或 Responses 协议');
    return context.connection.protocol;
  }
  async probe(context: ProbeContext) {
    this.protocol(context);
    const token = context.connection.authMode === 'none' ? undefined : await context.getSecret(context.connection.secretRef);
    return { models: await modelCatalog(context, token, false), capabilities: capabilities(false) };
  }
  async run(context: RunContext) {
    const protocol = this.protocol(context);
    const token = context.connection.authMode === 'none' ? undefined : await context.getSecret(context.connection.secretRef);
    if (context.connection.authMode !== 'none' && !token) throw new Error('请填写 API 密钥');
    try { return await runManaged(createClient(endpoint(context.connection), token), context, protocol, undefined, { chatReplay: this.chatReplay }); }
    catch (error) { throw providerError(error); }
  }
  async close() { this.chatReplay.clear(); }
}
