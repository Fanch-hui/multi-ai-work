import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import OpenAI from 'openai';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { RunContext } from '../src/domain/provider.js';
import { configureProviderWebSocket, type ProviderSocket } from '../src/providers/network.js';
import { createResponsesTransport } from '../src/providers/managed/responses-transport.js';
import { OAUTH_ISSUER } from '../src/providers/managed/oauth-tokens.js';

type Request = Record<string, unknown> & { input: unknown[] };
let server: Server, websocket: WebSocketServer, address: string;
let requests: Request[], connections: number, sessions: (string | undefined)[], socketUrls: string[];
let respond: (socket: WebSocket, request: Request) => void;
const transports: ReturnType<typeof createResponsesTransport>[] = [];
const output = [{ type: 'message', id: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'done', annotations: [] }] }];
function completed(socket: WebSocket, id = 'response') {
  socket.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output } }));
}
const body = (input: unknown[] = [{ role: 'user', content: 'start' }]): ResponseCreateParamsStreaming =>
  ({ model: 'gpt-6.1-sol', instructions: 'fixture', input, store: false, stream: true }) as ResponseCreateParamsStreaming;
const context = (): RunContext => ({ connection: { id: 'connection', provider: 'custom' }, binding: { id: 'binding' },
  signal: new AbortController().signal }) as RunContext;
function setup(baseURL = 'https://api.openai.com/v1', run = context()) {
  const http = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'http', status: 'completed', output } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }));
  const transport = createResponsesTransport(new OpenAI({ apiKey: 'fixture', baseURL, fetch: http, maxRetries: 0 }), run);
  transports.push(transport);
  return { transport, http };
}
async function consume(transport: ReturnType<typeof createResponsesTransport>, request = body(), signal = new AbortController().signal) {
  const events = [];
  for await (const event of await transport.stream(request, signal)) events.push(event);
  return events;
}

beforeEach(async () => {
  requests = []; connections = 0; sessions = []; socketUrls = [];
  server = createServer(); websocket = new WebSocketServer({ server });
  websocket.on('connection', (socket, request) => {
    connections++; sessions.push(request.headers['session-id'] as string | undefined);
    socket.on('message', raw => { const request = JSON.parse(String(raw)); requests.push(request); respond(socket, request); });
  });
  respond = socket => completed(socket);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  address = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  configureProviderWebSocket((url, headers) => {
    socketUrls.push(url);
    const socket = new WebSocket(address, { headers }); socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
});
afterEach(async () => {
  transports.splice(0).forEach(transport => transport.close());
  for (const socket of websocket.clients) socket.terminate();
  await new Promise<void>(resolve => websocket.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  configureProviderWebSocket((url, headers) => {
    const socket = new WebSocket(url, { headers, followRedirects: false }); socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
});

describe('Responses WebSocket transport', () => {
  it('reuses a connection and sends only strictly appended input after completed output', async () => {
    const { transport, http } = setup();
    const first = body(); await consume(transport, first);
    const extra = { role: 'user', content: 'next' };
    await consume(transport, { ...body([...(first.input as unknown[]), ...output, extra]),
      prompt_cache_options: { comparison_response_id: 'response' } });
    expect(connections).toBe(1); expect(sessions).toEqual(['binding']);
    expect(socketUrls).toEqual(['wss://api.openai.com/v1/responses']);
    expect(requests[0]).toMatchObject({ type: 'response.create', store: false });
    expect(requests[0]).not.toHaveProperty('stream'); expect(requests[0]).not.toHaveProperty('background');
    expect(requests[1]).toMatchObject({ previous_response_id: 'response', input: [extra] });
    expect(http).not.toHaveBeenCalled();
  });

  it('sends full input when instructions, tools, or prior history change', async () => {
    const { transport } = setup(); await consume(transport);
    const next = body([{ role: 'user', content: 'changed' }, ...output]);
    await consume(transport, next);
    await consume(transport, { ...body([...(next.input as unknown[]), ...output]), instructions: 'new instructions' });
    await consume(transport, { ...body([...(next.input as unknown[]), ...output]), instructions: 'new instructions',
      tools: [{ type: 'function', name: 'read_file', parameters: {}, strict: false }] });
    for (const request of requests) expect(request).not.toHaveProperty('previous_response_id');
    expect(requests[1].input).toEqual(next.input);
  });

  it('preserves cache TTL and mode in the continuation compatibility check', async () => {
    const { transport } = setup(); await consume(transport);
    const second = body([...(body().input as unknown[]), ...output, { role: 'user', content: 'second' }]);
    await consume(transport, { ...second, prompt_cache_options: { mode: 'implicit', ttl: '30m' } });
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    const third = body([...(second.input as unknown[]), ...output, { role: 'user', content: 'third' }]);
    await consume(transport, { ...third, prompt_cache_options: { mode: 'implicit', ttl: '30m', comparison_response_id: 'response' } });
    expect(requests[2]).toHaveProperty('previous_response_id');
    await consume(transport, { ...body([...(third.input as unknown[]), ...output]), prompt_cache_options: { mode: 'explicit', ttl: '30m' } });
    expect(requests[3]).not.toHaveProperty('previous_response_id');
  });

  it('replays full local input when the server no longer knows the previous response', async () => {
    const { transport, http } = setup(); await consume(transport);
    respond = (socket, request) => request.previous_response_id
      ? socket.send(JSON.stringify({ type: 'error', status: 400, error: { code: 'previous_response_not_found' } })) : completed(socket, 'new');
    const next = body([...(body().input as unknown[]), ...output, { role: 'user', content: 'next' }]);
    await consume(transport, next);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toHaveProperty('previous_response_id');
    expect(requests[2]).not.toHaveProperty('previous_response_id');
    expect(requests[2].input).toEqual(next.input); expect(http).not.toHaveBeenCalled();
  });

  it('uses HTTP for the rest of the run after handshake failure', async () => {
    let attempts = 0;
    configureProviderWebSocket(() => {
      attempts++; const socket = new WebSocket(address.replace('ws:', 'http:') + '/reject');
      socket.on('error', () => {}); queueMicrotask(() => socket.terminate());
      return socket as unknown as ProviderSocket;
    });
    const { transport, http } = setup();
    await consume(transport); await consume(transport);
    expect(attempts).toBe(1); expect(http).toHaveBeenCalledTimes(2);
  });

  it('passes partial-output disconnects upward and reconnects with full history on retry', async () => {
    const { transport, http } = setup();
    respond = socket => { socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })); socket.close(); };
    await expect(consume(transport)).rejects.toThrow('流已中断');
    expect(http).not.toHaveBeenCalled();
    respond = socket => completed(socket);
    await consume(transport);
    expect(connections).toBe(2); expect(requests[1]).not.toHaveProperty('previous_response_id');
  });

  it('falls back with full input if the socket closes before any model output', async () => {
    const { transport, http } = setup();
    respond = socket => { socket.send(JSON.stringify({ type: 'response.created', response: { id: 'starting', output: [] } })); socket.close(); };
    const events = await consume(transport);
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: 'response.completed', response: { id: 'http' } });
    expect(http).toHaveBeenCalledOnce();
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body)).input).toEqual(body().input);
  });

  it('passes explicit rate limits to normal retry handling without an extra HTTP request', async () => {
    const { transport, http } = setup();
    respond = socket => socket.send(JSON.stringify({ type: 'error', status: 429, error: { code: 'rate_limit_exceeded' } }));
    await expect(consume(transport)).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded' });
    expect(http).not.toHaveBeenCalled();
  });

  it('closes cancelled requests without sending an HTTP fallback', async () => {
    const { transport, http } = setup(); const controller = new AbortController();
    respond = () => controller.abort(new Error('cancelled'));
    await expect(consume(transport, body(), controller.signal)).rejects.toThrow('cancelled');
    expect(http).not.toHaveBeenCalled();
  });

  it('separates bindings and reconnects after OAuth credentials rotate', async () => {
    let token = 'fixture-a';
    const run = context(); run.connection.provider = 'chatgpt';
    run.getSecret = async () => JSON.stringify({ client_id: 'client', subject: 'subject', issuer: OAUTH_ISSUER,
      ext_agent_host_id: 'host', access_token: token, id_token: 'fixture-id', token_type: 'Bearer',
      scopes: ['chatgpt.tokens.use.direct'], expires_at: Date.now() + 3600000 });
    run.saveSecret = async () => {};
    const { transport } = setup(undefined, run); await consume(transport);
    token = 'fixture-b'; await consume(transport, body([...(body().input as unknown[]), ...output]));
    run.binding.id = 'another-binding'; await consume(transport);
    expect(connections).toBe(3); expect(sessions).toEqual(['binding', 'binding', 'another-binding']);
    for (const request of requests) expect(request).not.toHaveProperty('previous_response_id');
  });

  it('keeps unknown custom API endpoints on HTTP with full input', async () => {
    const { transport, http } = setup('https://custom.example/v1'); await consume(transport);
    expect(connections).toBe(0); expect(http).toHaveBeenCalledOnce();
    const request = JSON.parse(String(http.mock.calls[0]?.[1]?.body));
    expect(request.input).toEqual(body().input); expect(request).not.toHaveProperty('previous_response_id');
  });
});
