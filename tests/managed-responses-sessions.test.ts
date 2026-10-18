import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProgress, ProviderEvent, RunContext } from '../src/domain/provider.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';
import { configureProviderFetch, configureProviderWebSocket, type ProviderSocket } from '../src/providers/network.js';

let server: Server, sockets: WebSocketServer, adapter: CustomApiAdapter;
let requests: Record<string, unknown>[], connections: number;
const output = [{ type: 'message', id: 'reply', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'done', annotations: [] }] }];
const http = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'unexpected HTTP' } }), { status: 400 }));

beforeEach(async () => {
  requests = []; connections = 0; http.mockClear(); adapter = new CustomApiAdapter();
  server = createServer(); sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    connections++;
    socket.on('message', raw => {
      requests.push(JSON.parse(String(raw)));
      socket.send(JSON.stringify({ type: 'response.completed', response: { id: `response-${requests.length}`,
        status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  configureProviderWebSocket((_url, headers) => {
    const socket = new WebSocket(address, { headers }); socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
  configureProviderFetch(http);
});
afterEach(async () => {
  await adapter.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  configureProviderFetch((input, init) => fetch(input, init));
  configureProviderWebSocket((url, headers) => {
    const socket = new WebSocket(url, { headers, followRedirects: false }); socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
});

describe('Responses sessions through the managed Adapter', () => {
  it('reuses a saved long-history response across runs with fresh cancellation and events', async () => {
    const firstEvents: ProviderEvent[] = [], secondEvents: ProviderEvent[] = [];
    const saved: ManagedProgress[] = [], old = new AbortController();
    const firstContext = context('first', firstEvents);
    firstContext.signal = old.signal;
    firstContext.messages = [{ role: 'user', content: 'long history '.repeat(20000) }];
    firstContext.saveProgress = async value => { saved.push(structuredClone(value)); };
    const first = await adapter.run(firstContext);
    expect(saved.at(-1)?.phase).toBe('complete');
    const firstEventCount = firstEvents.length;
    old.abort();
    const second = await adapter.run({ ...context('second', secondEvents), messages: first.contextMessages!, prompt: 'next' });
    expect(second.text).toBe('done'); expect(connections).toBe(1);
    expect(requests[1]).toMatchObject({ previous_response_id: 'response-1', input: [{ role: 'user', content: 'next' }] });
    expect(JSON.stringify(requests[1]).length).toBeLessThan(JSON.stringify(requests[0]).length / 100);
    expect(firstEvents).toHaveLength(firstEventCount);
    expect(secondEvents.some(event => event.data.requestId === 'second:1')).toBe(true);
    expect(http).not.toHaveBeenCalled();
  });

  it('discards a completed wire response when its checkpoint fails to save', async () => {
    let checkpoint: ManagedProgress | undefined;
    const run = context('first', []);
    run.saveProgress = async progress => {
      checkpoint = structuredClone(progress);
      if (progress.phase === 'complete') throw new Error('checkpoint save failed');
    };
    await expect(adapter.run(run)).rejects.toThrow('checkpoint save failed');
    await adapter.run({ ...context('second', []), messages: checkpoint!.messages, prompt: 'next' });
    expect(connections).toBe(2);
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    expect(requests[1].input).toHaveLength(3);
    expect(http).not.toHaveBeenCalled();
  });
});

function context(runId: string, events: ProviderEvent[]): RunContext {
  return { runId, bot: { model: 'fixture' } as RunContext['bot'], connection: {
    id: 'connection', revision: 1, provider: 'custom', protocol: 'responses',
    authMode: 'none', baseUrl: 'https://api.openai.com/v1',
  } as RunContext['connection'], binding: { id: 'binding', generation: 1 } as RunContext['binding'],
  workspacePath: '/workspace', prompt: 'start', messages: [], instructions: 'system', tools: [], signal: new AbortController().signal,
  nativeMcp: { command: '', args: [], env: {} }, emit: event => { events.push(event); }, executeTool: async () => {},
  getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {} };
}
