import { lookup } from 'node:dns/promises';
import http, { type RequestOptions } from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolConnection } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { createToolRegistry } from '../src/tools/index.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('HTTP search protocols', () => {
  const registry = createToolRegistry();
  const connection: ToolConnection = { id: 'search', name: 'Search', kind: 'search', enabled: true,
    url: 'https://api.deepseek.com/v1/tools/search', toolNames: [], status: 'untested', secretRef: 'fixture' };
  const result = { results: [{ title: 'Source', url: 'https://example.com/source', summary: 'Search summary' }] };
  let server: http.Server;
  let received: { method?: string; path?: string; headers: http.IncomingHttpHeaders; body: string }[];
  let response: unknown;
  let status: number;
  let location: string | undefined;

  function context(item: ToolConnection, secret: string | undefined = 'test-key') {
    return { signal: new AbortController().signal, toolConnections: [item], getSecret: async () => secret } as ToolExecutionContext;
  }

  beforeEach(async () => {
    received = []; response = result; status = 200; location = undefined;
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    server = http.createServer(async (request, reply) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      received.push({ method: request.method, path: request.url, headers: request.headers, body });
      reply.writeHead(status, { 'Content-Type': 'application/json', ...(location ? { Location: location } : {}) });
      reply.end(JSON.stringify(response));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const get = http.get.bind(http), request = http.request.bind(http);
    // Keep the real HTTP transport while routing the validated public endpoint to the test server.
    const local = (url: URL, options: RequestOptions): RequestOptions => ({ ...options, hostname: '127.0.0.1',
      port: address.port, path: url.pathname + url.search, lookup: undefined });
    vi.spyOn(https, 'get').mockImplementation(((url: URL, options: RequestOptions, callback: (reply: http.IncomingMessage) => void) =>
      get(local(url, options), callback)) as typeof https.get);
    vi.spyOn(https, 'request').mockImplementation(((url: URL, options: RequestOptions, callback: (reply: http.IncomingMessage) => void) =>
      request(local(url, options), callback)) as typeof https.request);
  });

  afterEach(async () => {
    vi.restoreAllMocks(); vi.mocked(lookup).mockReset();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('uses authenticated POST JSON for both DeepSeek detection and actual tool execution', async () => {
    const item = { ...connection, searchBackend: 'deepseek' as const };
    expect(await registry.probeConnection(item, async () => 'test-key')).toEqual(['search_web']);
    const output = await registry.execute('search_web', { query: '中文资料' }, context(item));
    expect(output).toMatchObject({ backend: 'deepseek', connectionId: item.id, service: item.name,
      results: result, sources: [{ title: 'Source', url: 'https://example.com/source' }] });
    expect(received).toHaveLength(2);
    for (const request of received) {
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/v1/tools/search');
      expect(request.headers.authorization).toBe('Bearer test-key');
      expect(request.headers['content-type']).toBe('application/json');
    }
    expect(JSON.parse(received[0].body)).toEqual({ query: 'multi-AI work connectivity' });
    expect(JSON.parse(received[1].body)).toEqual({ query: '中文资料' });
  });

  it.each([undefined, 'http'] as const)('preserves GET and q for existing HTTP configurations (%s)', async searchBackend => {
    const item = { ...connection, url: 'https://example.com/search?lang=zh', searchBackend };
    await registry.probeConnection(item, async () => 'test-key');
    expect(await registry.execute('search_web', { query: '中文资料' }, context(item))).toMatchObject({ backend: 'http', results: result });
    expect(received.map(request => request.method)).toEqual(['GET', 'GET']);
    expect(new URL(received[1].path!, 'https://example.com').searchParams.get('q')).toBe('中文资料');
    expect(received[1].path).toContain('lang=zh');
    expect(received[1].headers.authorization).toBe('Bearer test-key');
    expect(received[1].body).toBe('');
  });

  it('validates the DeepSeek credential and query before sending, counting Unicode characters', async () => {
    const item = { ...connection, searchBackend: 'deepseek' as const };
    await expect(registry.execute('search_web', { query: '资料' }, { ...context(item), getSecret: async () => undefined })).rejects.toThrow('API Key');
    for (const query of ['   ', '字'.repeat(129)])
      await expect(registry.execute('search_web', { query }, context(item))).rejects.toThrow('128');
    expect(received).toHaveLength(0);
    await registry.execute('search_web', { query: '😀'.repeat(128) }, context(item));
    expect(received).toHaveLength(1);
  });

  it('accepts empty results and rejects a malformed DeepSeek success response during detection', async () => {
    const item = { ...connection, searchBackend: 'deepseek' as const };
    response = { results: [] };
    expect(await registry.probeConnection(item, async () => 'test-key')).toEqual(['search_web']);
    response = { message: 'not a search endpoint' };
    await expect(registry.probeConnection(item, async () => 'test-key')).rejects.toThrow('results');
  });

  it('reports HTTP failures and requires a final POST endpoint instead of forwarding credentials on redirects', async () => {
    const item = { ...connection, searchBackend: 'deepseek' as const };
    status = 401;
    await expect(registry.probeConnection(item, async () => 'test-key')).rejects.toThrow('HTTP 401');
    status = 307; location = 'https://other.example/search';
    await expect(registry.probeConnection(item, async () => 'test-key')).rejects.toThrow('最终接口地址');
    expect(received).toHaveLength(2);
  });
});
