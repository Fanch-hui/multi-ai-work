import { lookup } from 'node:dns/promises';
import http, { type RequestOptions } from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolConnection } from '../src/domain/types.js';
import type { ToolExecutionContext, ToolRegistry } from '../src/domain/tools.js';
import { createToolRegistry } from '../src/tools/index.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('shared network concurrency', () => {
  let registry: ToolRegistry;
  let server: http.Server;
  let received: Map<string, http.ServerResponse>;
  const connection: ToolConnection = {
    id: 'search-a',
    name: 'Search A',
    kind: 'search',
    enabled: true,
    url: 'https://search.example/query',
    toolNames: [],
    status: 'untested',
  };

  function context(
    runId: string,
    overrides: Partial<ToolExecutionContext> = {},
  ): ToolExecutionContext {
    return {
      runId,
      signal: new AbortController().signal,
      toolConnections: [connection],
      getSecret: async () => undefined,
      ...overrides,
    } as ToolExecutionContext;
  }

  function finish(id: string, status = 200): void {
    const reply = received.get(id)!;
    reply.writeHead(status, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify({ results: [{ title: id, url: `https://source.example/${id}` }] }));
  }

  beforeEach(async () => {
    registry = createToolRegistry();
    received = new Map();
    vi.mocked(lookup).mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
    server = http.createServer((request, reply) => {
      const url = new URL(request.url!, 'https://fixture.example');
      received.set(url.searchParams.get('q') ?? url.pathname.slice(1), reply);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as { port: number };
    const get = http.get.bind(http);
    vi.spyOn(https, 'get').mockImplementation(((
      url: URL,
      options: RequestOptions,
      callback: (reply: http.IncomingMessage) => void,
    ) =>
      get(
        {
          ...options,
          hostname: '127.0.0.1',
          port: address.port,
          path: url.pathname + url.search,
          lookup: undefined,
        },
        callback,
      )) as typeof https.get);
  });

  afterEach(async () => {
    for (const reply of received.values()) if (!reply.writableEnded) reply.end('{}');
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await registry.close();
    vi.restoreAllMocks();
    vi.mocked(lookup).mockReset();
  });

  it.each(['search_web', 'fetch_web'])(
    'limits %s to two requests across runs and lets another service proceed',
    async (tool) => {
      const call = (id: string, other = false) => {
        const item = other ? { ...connection, id: 'search-b' } : connection;
        const args =
          tool === 'search_web'
            ? { query: id }
            : { url: `https://${other ? 'other' : 'web'}.example/${id}` };
        return registry.execute(tool, args, context(id, { toolConnections: [item] }));
      };
      const first = call('first'),
        second = call('second'),
        queued = call('queued'),
        other = call('other', true);
      await vi.waitFor(() =>
        expect([...received.keys()].sort()).toEqual(['first', 'other', 'second']),
      );
      finish('first');
      await first;
      await vi.waitFor(() => expect(received.has('queued')).toBe(true));
      finish('second');
      finish('queued');
      finish('other');
      await Promise.all([second, queued, other]);
    },
  );

  it('removes a canceled waiter without waiting for active requests', async () => {
    const first = registry.execute('search_web', { query: 'first' }, context('first'));
    const second = registry.execute('search_web', { query: 'second' }, context('second'));
    const controller = new AbortController();
    const queued = registry.execute(
      'search_web',
      { query: 'canceled' },
      context('canceled', { signal: controller.signal }),
    );
    const canceled = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    const next = registry.execute('search_web', { query: 'next' }, context('next'));
    await vi.waitFor(() => expect(received.size).toBe(2));
    controller.abort();
    await canceled;
    expect(received.has('canceled')).toBe(false);
    finish('first');
    await first;
    await vi.waitFor(() => expect(received.has('next')).toBe(true));
    finish('second');
    finish('next');
    await Promise.all([second, next]);
  });

  it('rechecks authorization after waiting and releases a rejected slot', async () => {
    const first = registry.execute(
      'fetch_web',
      { url: 'https://web.example/first' },
      context('first'),
    );
    const second = registry.execute(
      'fetch_web',
      { url: 'https://web.example/second' },
      context('second'),
    );
    let authorized = true;
    const assertAuthorized = vi.fn(() => {
      if (!authorized) throw new Error('permission revoked');
    });
    const queued = registry.execute(
      'fetch_web',
      { url: 'https://web.example/revoked' },
      context('revoked', { assertAuthorized }),
    );
    const rejected = expect(queued).rejects.toThrow('permission revoked');
    const next = registry.execute(
      'fetch_web',
      { url: 'https://web.example/next' },
      context('next'),
    );
    await vi.waitFor(() => expect(received.size).toBe(2));
    expect(assertAuthorized).not.toHaveBeenCalled();
    authorized = false;
    finish('first');
    await first;
    await rejected;
    expect(assertAuthorized).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(received.has('next')).toBe(true));
    expect(received.has('revoked')).toBe(false);
    finish('second');
    finish('next');
    await Promise.all([second, next]);
  });

  it('releases the slot after an HTTP failure and allows the next request', async () => {
    const first = registry.execute('search_web', { query: 'failed' }, context('first'));
    const rejected = expect(first).rejects.toThrow('HTTP 429');
    const second = registry.execute('search_web', { query: 'second' }, context('second'));
    const queued = registry.execute('search_web', { query: 'queued' }, context('queued'));
    await vi.waitFor(() => expect(received.size).toBe(2));
    finish('failed', 429);
    await rejected;
    await vi.waitFor(() => expect(received.has('queued')).toBe(true));
    finish('second');
    finish('queued');
    await Promise.all([second, queued]);
  });
});
