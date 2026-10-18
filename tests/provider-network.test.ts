import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationRequiredError, type RunContext } from '../src/domain/provider.js';
import { configureProviderFetch, configureProviderWebSocket, providerFetch } from '../src/providers/network.js';
import { ChatGptAdapter, CustomApiAdapter } from '../src/providers/managed/index.js';
import { providerError } from '../src/providers/managed/client.js';
import { OAUTH_ISSUER, revokeTokens, type OAuthTokens } from '../src/providers/managed/oauth-tokens.js';

let server: Server | undefined;
beforeEach(() => configureProviderWebSocket(() => { throw new Error('HTTP transport fixture'); }));
afterEach(async () => {
  configureProviderFetch((input, init) => fetch(input, init));
  vi.restoreAllMocks();
  if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
  server = undefined;
});

describe('provider network transport', () => {
  it('uses one transport for token refresh, identity keys, catalogs, inference and revocation', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'network-fixture' })
      .setIssuer(OAUTH_ISSUER).setSubject('fixture-subject').setAudience('fixture-client')
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const key = { ...await exportJWK(publicKey), kid: 'network-fixture' };
    const requests: { path: string; bearer?: string; body: string }[] = [];
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const path = request.url!;
      requests.push({ path, bearer: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      if (path === '/api/accounts/oauth/token') response.end(JSON.stringify({ access_token: 'renewed-fixture',
        token_type: 'Bearer', expires_in: 300, id_token: idToken, scope: 'chatgpt.tokens.use.direct' }));
      else if (path === '/.well-known/jwks.json') response.end(JSON.stringify({ keys: [key] }));
      else if (path === '/v1/models') response.end(JSON.stringify({ models: [{ slug: 'fixture-model', visibility: 'list',
        context_window: 272000, max_context_window: 1000000, supported_reasoning_levels: [], input_modalities: ['text'] }] }));
      else if (path === '/.well-known/openid-configuration') response.end(JSON.stringify({ issuer: OAUTH_ISSUER,
        revocation_endpoint: `${OAUTH_ISSUER}/revoke` }));
      else if (path === '/revoke') response.end('{}');
      else if (path === '/v1/responses') {
        response.setHeader('content-type', 'text/event-stream');
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
          { type: 'message', id: 'answer', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: '收到', annotations: [] }] },
        ] } })}\n\n`);
      } else response.writeHead(404).end('{}');
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server unavailable');
    const options: RequestInit[] = [];
    configureProviderFetch((input, init) => {
      options.push(init!);
      const request = new Request(input, init);
      return fetch(new Request(`http://127.0.0.1:${address.port}${new URL(request.url).pathname}`, request));
    });
    let record: OAuthTokens = { client_id: 'fixture-client', subject: 'fixture-subject', issuer: OAUTH_ISSUER,
      ext_agent_host_id: 'fixture-host', access_token: 'expired-fixture', refresh_token: 'refresh-fixture',
      id_token: idToken, token_type: 'Bearer', scopes: ['chatgpt.tokens.use.direct'], expires_at: 0 };
    const context = runContext(async () => JSON.stringify(record), async (_ref, value) => { record = JSON.parse(value); });
    const adapter = new ChatGptAdapter();
    const probe = await adapter.probe(context);
    expect(probe.models[0].maxContextWindow).toBe(1000000);
    expect((await adapter.run(context)).text).toBe('收到');
    expect(await revokeTokens(record)).toBe(true);
    expect(requests.map(request => request.path)).toEqual(['/api/accounts/oauth/token', '/.well-known/jwks.json',
      '/v1/models', '/v1/responses', '/.well-known/openid-configuration', '/revoke']);
    expect(requests.filter(request => request.path.startsWith('/v1/')).map(request => request.bearer))
      .toEqual(['Bearer renewed-fixture', 'Bearer renewed-fixture']);
    expect(JSON.parse(requests.find(request => request.path === '/v1/responses')!.body))
      .toMatchObject({ model: 'fixture-model', stream: true, store: false });
    expect(options.every(option => option.credentials === 'omit')).toBe(true);
    expect(options.every(option => ['manual', 'error'].includes(option.redirect!))).toBe(true);
  });

  it('reports stable network codes without exposing request or credentials and preserves cancellation', async () => {
    const failure = new TypeError('fetch failed https://private.example/?secret=fixture', { cause: { code: 'ECONNRESET' } });
    configureProviderFetch(async () => { throw failure; });
    const adapter = new ChatGptAdapter();
    const expired = { client_id: 'fixture-client', subject: 'fixture-subject', issuer: OAUTH_ISSUER,
      access_token: 'expired-fixture', refresh_token: 'refresh-fixture', id_token: 'fixture', token_type: 'Bearer',
      scopes: ['chatgpt.tokens.use.direct'], expires_at: 0 };
    await expect(adapter.run(runContext(async () => JSON.stringify(expired), async () => {})))
      .rejects.toThrow('模型服务网络连接失败（ECONNRESET），请检查网络后重试');
    expect(providerError(new OpenAI.APIConnectionError({ cause: failure })).message)
      .toBe('模型服务网络连接失败（ECONNRESET），请检查网络后重试');
    const controller = new AbortController(); controller.abort();
    await expect(providerFetch('https://api.openai.com/v1/models', { signal: controller.signal })).rejects.toBe(failure);
  });

  it('also routes custom providers through the configured transport', async () => {
    let requested = false;
    configureProviderFetch(async (input, init) => {
      requested = true;
      expect(new Request(input, init).headers.has('authorization')).toBe(false);
      return new Response(JSON.stringify({ data: [{ id: 'custom-model' }] }), { headers: { 'content-type': 'application/json' } });
    });
    const context = runContext(async () => undefined);
    context.connection = { ...context.connection, provider: 'custom', protocol: 'responses', authMode: 'none', baseUrl: 'https://fixture.example/v1' };
    expect((await new CustomApiAdapter().probe(context)).models[0].id).toBe('custom-model');
    expect(requested).toBe(true);
  });

  it.each(['expiry', 'rejected'] as const)('renews authorization between tool rounds after %s without replaying tools', async mode => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let record = oauthFixture(now + 120_000), refreshes = 0, writes = 0;
    const inputs: Record<string, unknown>[] = [], bearers: (string | null)[] = [];
    configureProviderFetch(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/api/accounts/oauth/token') {
        refreshes++;
        return new Response(JSON.stringify({ access_token: 'renewed-fixture', token_type: 'Bearer', expires_in: 3600 }));
      }
      inputs.push(await request.json());
      bearers.push(request.headers.get('authorization'));
      if (inputs.length === 1) return responseStream([{ type: 'function_call', id: 'function1', call_id: 'call1',
        name: 'write', arguments: '{}', status: 'completed' }]);
      if (mode === 'rejected' && inputs.length === 2) {
        return new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 });
      }
      return responseStream([{ type: 'message', id: 'answer', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '完成', annotations: [] }] }]);
    });
    const context = runContext(async () => JSON.stringify(record), async (_ref, value) => { record = JSON.parse(value); });
    context.tools = [{ name: 'write', description: 'Write', inputSchema: { type: 'object' } }];
    context.executeTool = async () => { writes++; if (mode === 'expiry') now += 120_001; return 'written'; };
    expect((await new ChatGptAdapter().run(context)).text).toBe('完成');
    expect(writes).toBe(1);
    expect(refreshes).toBe(1);
    expect(bearers).toEqual(mode === 'expiry' ? ['Bearer original-fixture', 'Bearer renewed-fixture']
      : ['Bearer original-fixture', 'Bearer original-fixture', 'Bearer renewed-fixture']);
    expect(inputs.at(-1)?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call1', output: 'written' }),
    ]));
    if (mode === 'rejected') expect(inputs[1]).toEqual(inputs[2]);
  });

  it.each([[401, 'invalid_api_key'], [403, 'token_expired'], [507, 'server_error_fixture']])(
    'preserves HTTP %s/%s without refreshing or replaying', async (status, code) => {
      let requests = 0;
      configureProviderFetch(async () => {
        requests++;
        return new Response(JSON.stringify({ error: { code } }), { status: status as number });
      });
      const context = runContext(async () => JSON.stringify(oauthFixture(Date.now() + 3600_000)));
      await expect(new ChatGptAdapter().run(context)).rejects.toThrow(`HTTP ${status}，${code}`);
      expect(requests).toBe(1);
    });

  it('retries an explicitly expired model request only once', async () => {
    let record = oauthFixture(Date.now() + 3600_000), refreshes = 0, requests = 0;
    configureProviderFetch(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/accounts/oauth/token')) {
        refreshes++;
        return new Response(JSON.stringify({ access_token: 'renewed-fixture', token_type: 'Bearer', expires_in: 3600 }));
      }
      requests++;
      return new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 });
    });
    const context = runContext(async () => JSON.stringify(record), async (_ref, value) => { record = JSON.parse(value); });
    await expect(new ChatGptAdapter().run(context)).rejects.toThrow('HTTP 401，token_expired');
    expect(requests).toBe(2);
    expect(refreshes).toBe(1);
  });

  it('preserves sign-in invalidation when refresh fails before a model request', async () => {
    configureProviderFetch(async () => new Response(JSON.stringify({ error: { code: 'invalid_grant' } }), { status: 401 }));
    await expect(new ChatGptAdapter().run(runContext(async () => JSON.stringify(oauthFixture(0)))))
      .rejects.toBeInstanceOf(AuthenticationRequiredError);
  });
});

function oauthFixture(expiresAt: number): OAuthTokens {
  return { client_id: 'fixture-client', subject: 'fixture-subject', issuer: OAUTH_ISSUER, ext_agent_host_id: 'fixture-host',
    access_token: 'original-fixture', refresh_token: 'refresh-fixture', id_token: 'fixture', token_type: 'Bearer',
    scopes: ['chatgpt.tokens.use.direct'], expires_at: expiresAt };
}
function responseStream(output: unknown[]): Response {
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

function runContext(getSecret: RunContext['getSecret'], saveSecret: RunContext['saveSecret'] = async () => {}): RunContext {
  return { connection: { id: 'fixture', provider: 'chatgpt', name: 'fixture', concurrency: 1, secretRef: 'fixture',
      status: 'ready', models: [], revision: 1, createdAt: '' },
    bot: { id: 'bot', name: 'bot', role: 'member', instructions: '', connectionId: 'fixture', model: 'fixture-model',
      color: '', toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false },
    binding: { id: 'binding', botId: 'bot', conversationId: 'room', connectionId: 'fixture', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'workspace', lastDeliveredSequence: 0 },
    runId: 'run', workspacePath: '/workspace', prompt: '收到请回复', instructions: 'Reply', messages: [], tools: [],
    nativeMcp: { command: '', args: [], env: {} }, signal: new AbortController().signal, getSecret, saveSecret,
    persistBinding: () => {}, emit: () => {}, executeTool: async () => undefined };
}
