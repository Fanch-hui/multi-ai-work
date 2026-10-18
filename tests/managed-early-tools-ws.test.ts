import { once } from 'node:events';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import WebSocket, { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import type { ManagedProgress, RunContext } from '../src/domain/provider.js';
import { configureProviderWebSocket, type ProviderSocket } from '../src/providers/network.js';
import { runManaged } from '../src/providers/managed/loop.js';

it('combines early read execution with one bound WebSocket and incremental continuation', async () => {
  const server = createServer(); const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const requests: Record<string, unknown>[] = []; const bindings: unknown[] = [];
  let active: WebSocket | undefined; let ended = false; let executions = 0;
  const saved: ManagedProgress[] = [];
  const call = { type: 'function_call', id: 'function', call_id: 'read-1', name: 'read', arguments: '{}', status: 'completed' };
  const reason = { type: 'reasoning', id: 'reason', encrypted_content: 'fixture', summary: [] };
  sockets.on('connection', (socket, request) => {
    active = socket; bindings.push(request.headers['session-id']);
    socket.on('message', raw => {
      requests.push(JSON.parse(String(raw)));
      if (requests.length === 1) {
        socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: reason }));
        socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: 1, item: call }));
      } else socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'second', status: 'completed', output: [
        { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] },
      ] } }));
    });
  });
  configureProviderWebSocket((_url, headers) => {
    const socket = new WebSocket(address, { headers }); socket.on('error', () => {}); return socket as unknown as ProviderSocket;
  });
  try {
    const http = vi.fn(async () => { throw new Error('unexpected HTTP'); });
    const context = {
      runId: 'run', bot: { model: 'model' }, connection: { id: 'connection', provider: 'custom' }, binding: { id: 'binding' },
      workspacePath: '/workspace', prompt: 'go', messages: [], instructions: 'Help', tools: [{ name: 'read', description: '', inputSchema: { type: 'object' } }],
      parallelToolNames: ['read'], signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
      executeTool: async () => {
        expect(ended).toBe(false); executions++;
        expect(saved.at(-1)?.messages.at(-1)?.providerItems).toEqual([reason, call]);
        ended = true;
        active!.send(JSON.stringify({ type: 'response.completed', response: { id: 'first', status: 'completed', output: [reason, call] } }));
        return { content: 'read result' };
      }, getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
      saveProgress: async (progress: ManagedProgress) => { saved.push(structuredClone(progress)); },
    } as unknown as RunContext;
    const result = await runManaged(new OpenAI({ apiKey: 'fixture', fetch: http, maxRetries: 0 }), context, 'responses', []);
    expect(result.text).toBe('Done'); expect(executions).toBe(1); expect(bindings).toEqual(['binding']);
    expect(requests[1]).toMatchObject({ previous_response_id: 'first', input: [
      { type: 'function_call_output', call_id: 'read-1', output: '{"content":"read result"}' },
    ] });
    expect(http).not.toHaveBeenCalled();
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    configureProviderWebSocket((url, headers) => {
      const socket = new WebSocket(url, { headers, followRedirects: false }); socket.on('error', () => {});
      return socket as unknown as ProviderSocket;
    });
  }
});
