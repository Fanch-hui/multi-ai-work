import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { State } from '../src/core/state.js';
import { ConnectorOAuth } from '../src/core/connector-oauth.js';
import type { ConnectorOAuthRecord } from '../src/core/connector-oauth-provider.js';
import type { ToolConnection } from '../src/domain/types.js';
import { Vault } from '../src/security/vault.js';
import { McpConnections } from '../src/tools/mcp.js';

const resources: { state: State; oauth: ConnectorOAuth; root: string }[] = [];
afterEach(async () => {
  for (const { state, oauth, root } of resources.splice(0)) {
    await oauth.close();
    state.storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function setup({ pkce = true, dynamicRegistration = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'connector-oauth-'));
  const state = new State(root),
    vault = new Vault(join(root, 'unused'));
  const connection: ToolConnection = {
    id: 'work-app',
    name: '工作应用',
    kind: 'mcp',
    transport: 'http',
    url: 'https://mcp.test/mcp',
    enabled: true,
    toolNames: [],
    status: 'untested',
  };
  state.storage.put('tool_connections', connection);
  const opened: URL[] = [],
    exchanges: URLSearchParams[] = [];
  let refreshes = 0;
  const oauth = new ConnectorOAuth(state, vault, {
    openExternal: async (value) => {
      opened.push(new URL(value));
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'mcp.test' && url.pathname === '/mcp') {
        const headers = new Headers(init?.headers);
        if (headers.get('Authorization') !== 'Bearer fixture-access')
          return new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate':
                'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="message:send"',
            },
          });
        if (init?.method === 'GET') return new Response('', { status: 405 });
        const message = JSON.parse(String(init?.body));
        if (!Object.hasOwn(message, 'id')) return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result:
            message.method === 'initialize'
              ? {
                  protocolVersion: '2025-11-25',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'fixture', version: '1' },
                }
              : { tools: [{ name: 'send_message', inputSchema: { type: 'object' } }] },
        });
      }
      if (
        url.hostname === 'mcp.test' &&
        url.pathname.startsWith('/.well-known/oauth-protected-resource')
      )
        return Response.json({
          resource: connection.url,
          authorization_servers: ['https://identity.test'],
          scopes_supported: ['message:send'],
        });
      if (url.hostname === 'identity.test' && url.pathname.startsWith('/.well-known/'))
        return Response.json({
          issuer: 'https://identity.test',
          authorization_endpoint: 'https://identity.test/authorize',
          token_endpoint: 'https://identity.test/token',
          ...(dynamicRegistration
            ? { registration_endpoint: 'https://identity.test/register' }
            : {}),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          ...(pkce ? { code_challenge_methods_supported: ['S256'] } : {}),
        });
      if (url.pathname === '/register') {
        const metadata = JSON.parse(String(init?.body));
        return Response.json({ ...metadata, client_id: 'fixture-client' }, { status: 201 });
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams(String(init?.body));
        exchanges.push(body);
        if (body.get('grant_type') === 'refresh_token') {
          refreshes++;
          return Response.json({
            access_token: 'fixture-rotated-access',
            refresh_token: 'fixture-rotated-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        const challenge = createHash('sha256')
          .update(body.get('code_verifier')!)
          .digest('base64url');
        expect(challenge).toBe(opened.at(-1)?.searchParams.get('code_challenge'));
        expect(body.get('resource')).toBe(connection.url);
        return Response.json({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      throw new Error(`测试中出现意外请求：${url.origin}${url.pathname}`);
    },
  });
  resources.push({ state, oauth, root });
  const complete = async () => {
    const authorization = opened.at(-1)!;
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    await response.text();
  };
  return {
    root,
    state,
    vault,
    oauth,
    connection,
    opened,
    exchanges,
    complete,
    refreshes: () => refreshes,
  };
}

describe('连接器标准 MCP OAuth', () => {
  it('同一连接的并发登录共享一轮授权与一个回调', async () => {
    const test = await setup();
    const results = await Promise.all([
      test.oauth.login(test.connection.id),
      test.oauth.login(test.connection.id),
    ]);
    expect(results.every((result) => result.phase === 'awaiting_user')).toBe(true);
    expect(test.opened).toHaveLength(1);
    await test.complete();
    expect(test.exchanges).toHaveLength(1);
  });
  it('明确登录后打开 PKCE 页面，严格校验回调并只在 Vault 保存凭据', async () => {
    const test = await setup();
    expect(test.oauth.provider(test.connection)).toBeUndefined();
    expect(await test.oauth.login(test.connection.id)).toMatchObject({ phase: 'awaiting_user' });
    expect(test.opened).toHaveLength(1);
    const authorization = test.opened[0];
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const invalid = new URL(authorization.searchParams.get('redirect_uri')!);
    invalid.searchParams.set('state', 'wrong-state');
    invalid.searchParams.set('code', 'fixture-code');
    const rejected = await fetch(invalid);
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(test.exchanges).toHaveLength(0);
    await test.complete();
    expect(await test.oauth.status(test.connection.id)).toMatchObject({ phase: 'connected' });
    expect(test.exchanges).toHaveLength(1);
    expect(JSON.stringify(test.state.snapshot())).not.toContain('fixture-access');
    expect((await readFile(test.state.storage.path)).includes(Buffer.from('fixture-access'))).toBe(
      false,
    );
    await expect(readFile(join(test.root, 'unused'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await test.oauth.provider(test.connection)!.tokens())?.access_token).toBe(
      'fixture-access',
    );
  });

  it('并发到期读取只刷新一次，保存轮换后的刷新凭据', async () => {
    const test = await setup();
    await test.oauth.login(test.connection.id);
    await test.complete();
    const ref = test.state.storage.metadata<string>(`connector-oauth-ref:${test.connection.id}`)!;
    const record = JSON.parse((await test.vault.get(ref))!) as ConnectorOAuthRecord;
    await test.vault.set(ref, JSON.stringify({ ...record, expiresAt: Date.now() - 1000 }));
    const first = test.oauth.provider(test.connection)!,
      second = test.oauth.provider(test.connection)!;
    const tokens = await Promise.all(
      Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).tokens()),
    );
    expect(tokens.every((value) => value?.access_token === 'fixture-rotated-access')).toBe(true);
    expect(test.refreshes()).toBe(1);
    expect(JSON.parse((await test.vault.get(ref))!).tokens.refresh_token).toBe(
      'fixture-rotated-refresh',
    );
  });

  it('普通任务不会自行打开授权页面；退出使现有 provider 失效', async () => {
    const test = await setup();
    await test.oauth.login(test.connection.id);
    await test.complete();
    const provider = test.oauth.provider(test.connection)!;
    await expect(
      provider.redirectToAuthorization(new URL('https://identity.test/authorize')),
    ).rejects.toThrow('点击登录');
    expect(test.opened).toHaveLength(1);
    await test.oauth.logout(test.connection.id);
    await expect(provider.tokens()).rejects.toThrow('配置已更改');
    expect(test.oauth.provider(test.connection)).toBeUndefined();
    expect(await test.oauth.status(test.connection.id)).toMatchObject({ phase: 'disconnected' });
  });

  it('授权服务器缺少 PKCE 时保持明确失败并关闭回调', async () => {
    const test = await setup({ pkce: false });
    await expect(test.oauth.login(test.connection.id)).rejects.toThrow('PKCE S256');
    expect(test.opened).toHaveLength(0);
    expect(await test.oauth.status(test.connection.id)).toMatchObject({ phase: 'error' });
  });

  it('预注册 Client ID 可用于未提供动态注册的服务', async () => {
    const test = await setup({ dynamicRegistration: false });
    await test.oauth.login(test.connection.id, {
      clientId: 'fixture-preregistered',
      issuer: 'https://identity.test',
    });
    expect(test.opened[0].searchParams.get('client_id')).toBe('fixture-preregistered');
    await test.complete();
    expect(await test.oauth.status(test.connection.id)).toMatchObject({ phase: 'connected' });
  });

  it('修改服务地址后旧 provider 禁止继续提供令牌', async () => {
    const test = await setup();
    await test.oauth.login(test.connection.id);
    await test.complete();
    const provider = test.oauth.provider(test.connection)!;
    test.state.storage.put('tool_connections', {
      ...test.connection,
      url: 'https://other.test/mcp',
    });
    await expect(provider.tokens()).rejects.toThrow('配置已更改');
    expect(test.opened).toHaveLength(1);
  });
  it('实际 MCP transport 使用已授权令牌发现工具', async () => {
    const test = await setup();
    const mcp = new McpConnections({
      oauthProvider: (connection) => test.oauth.provider(connection),
      fetch: test.oauth.fetch,
      oauthFetch: test.oauth.fetch,
    });
    try {
      await expect(mcp.probe(test.connection, async () => undefined)).rejects.toThrow();
      expect(test.opened).toHaveLength(0);
      await test.oauth.login(test.connection.id);
      await test.complete();
      expect(await mcp.probe(test.connection, async () => undefined)).toEqual(['send_message']);
    } finally {
      await mcp.close();
    }
  });
  it('备份恢复前取消授权，恢复的元数据不会续用旧登录', async () => {
    const test = await setup();
    await test.oauth.login(test.connection.id);
    const authorization = test.opened[0];
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    const oldProvider = test.oauth.provider(test.connection)!;
    const ref = test.state.storage.metadata<string>(`connector-oauth-ref:${test.connection.id}`)!;
    await test.oauth.prepareRestore();
    test.state.storage.setMetadata(`connector-oauth-enabled:${test.connection.id}`, true);
    test.state.storage.setMetadata(`connector-oauth-ref:${test.connection.id}`, ref);
    await test.oauth.finishRestore();
    await expect(oldProvider.tokens()).rejects.toThrow('配置已更改');
    await expect(fetch(callback)).rejects.toThrow();
    expect(test.exchanges).toHaveLength(0);
    expect(test.oauth.provider(test.connection)).toBeUndefined();
    expect(await test.oauth.status(test.connection.id)).toMatchObject({ phase: 'disconnected' });
    await test.oauth.login(test.connection.id);
    await test.complete();
    expect(await test.oauth.status(test.connection.id)).toMatchObject({ phase: 'connected' });
  });
});
