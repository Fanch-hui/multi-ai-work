import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import OpenAI from 'openai';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { RunContext } from '../src/domain/provider.js';
import { configureProviderWebSocket, type ProviderSocket } from '../src/providers/network.js';
import { ResponsesSessionPool } from '../src/providers/managed/responses-session-pool.js';
import { createResponsesTransport } from '../src/providers/managed/responses-transport.js';
import { OAUTH_ISSUER } from '../src/providers/managed/oauth-tokens.js';

type Request = Record<string, unknown> & { input: unknown[] };
let server: Server, websocket: WebSocketServer, address: string;
let requests: Request[],
  connections: number,
  sessions: (string | undefined)[],
  socketUrls: string[];
let respond: (socket: WebSocket, request: Request) => void;
const transports: ReturnType<typeof createResponsesTransport>[] = [];
const output = [
  {
    type: 'message',
    id: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done', annotations: [] }],
  },
];
function completed(socket: WebSocket, id = 'response') {
  socket.send(
    JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output } }),
  );
}
const body = (
  input: unknown[] = [{ role: 'user', content: 'start' }],
): ResponseCreateParamsStreaming =>
  ({
    model: 'gpt-6.1-sol',
    instructions: 'fixture',
    input,
    store: false,
    stream: true,
  }) as ResponseCreateParamsStreaming;
const context = (): RunContext =>
  ({
    connection: { id: 'connection', provider: 'custom' },
    binding: { id: 'binding', generation: 1 },
    signal: new AbortController().signal,
  }) as RunContext;
function setup(
  baseURL = 'https://api.openai.com/v1',
  run = context(),
  pool?: ResponsesSessionPool,
  apiKey = 'fixture',
) {
  const http = vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'http', status: 'completed', output } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const transport = createResponsesTransport(
    new OpenAI({ apiKey, baseURL, fetch: http, maxRetries: 0 }),
    run,
    pool,
  );
  transports.push(transport);
  return { transport, http };
}
async function consume(
  transport: ReturnType<typeof createResponsesTransport>,
  request = body(),
  signal = new AbortController().signal,
) {
  const events = [];
  for await (const event of await transport.stream(request, signal)) events.push(event);
  transport.confirm(output);
  return events;
}

beforeEach(async () => {
  requests = [];
  connections = 0;
  sessions = [];
  socketUrls = [];
  server = createServer();
  websocket = new WebSocketServer({ server });
  websocket.on('connection', (socket, request) => {
    connections++;
    sessions.push(request.headers['session-id'] as string | undefined);
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw));
      requests.push(request);
      respond(socket, request);
    });
  });
  respond = (socket) => completed(socket);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  address = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  configureProviderWebSocket((url, headers) => {
    socketUrls.push(url);
    const socket = new WebSocket(address, { headers });
    socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
});
afterEach(async () => {
  transports.splice(0).forEach((transport) => transport.close());
  for (const socket of websocket.clients) socket.terminate();
  await new Promise<void>((resolve) => websocket.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  configureProviderWebSocket((url, headers) => {
    const socket = new WebSocket(url, { headers, followRedirects: false });
    socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
});

describe('Responses WebSocket transport', () => {
  it('reuses a connection and sends only strictly appended input after completed output', async () => {
    const { transport, http } = setup();
    const first = body();
    await consume(transport, first);
    const extra = { role: 'user', content: 'next' };
    await consume(transport, {
      ...body([...(first.input as unknown[]), ...output, extra]),
      prompt_cache_options: { comparison_response_id: 'response' },
    });
    expect(connections).toBe(1);
    expect(sessions).toEqual(['binding']);
    expect(socketUrls).toEqual(['wss://api.openai.com/v1/responses']);
    expect(requests[0]).toMatchObject({ type: 'response.create', store: false });
    expect(requests[0]).not.toHaveProperty('stream');
    expect(requests[0]).not.toHaveProperty('background');
    expect(requests[1]).toMatchObject({ previous_response_id: 'response', input: [extra] });
    expect(http).not.toHaveBeenCalled();
  });

  it('continues the same response while appended updates change the effective reasoning effort', async () => {
    const { transport, http } = setup();
    let history: unknown[] = [{ role: 'user', content: 'start' }];
    for (const effort of ['medium', 'high', 'low']) {
      const update = { type: 'configuration_update', reasoning: { effort } };
      const extra = history.length === 1 ? [] : [{ role: 'user', content: `continue ${effort}` }];
      history = [...history, ...extra, update];
      await consume(transport, { ...body(history), reasoning: { effort: 'medium' } });
      history = [...history, ...output];
    }

    expect(connections).toBe(1);
    expect(requests.map((request) => request.reasoning)).toEqual([
      { effort: 'medium' },
      { effort: 'medium' },
      { effort: 'medium' },
    ]);
    expect(requests.slice(1).map((request) => request.previous_response_id)).toEqual([
      'response',
      'response',
    ]);
    expect(requests.slice(1).map((request) => request.input)).toEqual([
      [
        { role: 'user', content: 'continue high' },
        { type: 'configuration_update', reasoning: { effort: 'high' } },
      ],
      [
        { role: 'user', content: 'continue low' },
        { type: 'configuration_update', reasoning: { effort: 'low' } },
      ],
    ]);
    expect(http).not.toHaveBeenCalled();
  });

  it('sends full input when instructions, tools, or prior history change', async () => {
    const { transport } = setup();
    await consume(transport);
    const next = body([{ role: 'user', content: 'changed' }, ...output]);
    await consume(transport, next);
    await consume(transport, {
      ...body([...(next.input as unknown[]), ...output]),
      instructions: 'new instructions',
    });
    await consume(transport, {
      ...body([...(next.input as unknown[]), ...output]),
      instructions: 'new instructions',
      tools: [{ type: 'function', name: 'read_file', parameters: {}, strict: false }],
    });
    for (const request of requests) expect(request).not.toHaveProperty('previous_response_id');
    expect(requests[1].input).toEqual(next.input);
  });

  it('preserves cache TTL and mode in the continuation compatibility check', async () => {
    const { transport } = setup();
    await consume(transport);
    const second = body([
      ...(body().input as unknown[]),
      ...output,
      { role: 'user', content: 'second' },
    ]);
    await consume(transport, { ...second, prompt_cache_options: { mode: 'implicit', ttl: '30m' } });
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    const third = body([
      ...(second.input as unknown[]),
      ...output,
      { role: 'user', content: 'third' },
    ]);
    await consume(transport, {
      ...third,
      prompt_cache_options: { mode: 'implicit', ttl: '30m', comparison_response_id: 'response' },
    });
    expect(requests[2]).toHaveProperty('previous_response_id');
    await consume(transport, {
      ...body([...(third.input as unknown[]), ...output]),
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    });
    expect(requests[3]).not.toHaveProperty('previous_response_id');
  });

  it('replays full local input when the server no longer knows the previous response', async () => {
    const { transport, http } = setup();
    await consume(transport);
    respond = (socket, request) =>
      request.previous_response_id
        ? socket.send(
            JSON.stringify({
              type: 'error',
              status: 400,
              error: { code: 'previous_response_not_found' },
            }),
          )
        : completed(socket, 'new');
    const next = body([
      ...(body().input as unknown[]),
      ...output,
      { role: 'user', content: 'next' },
    ]);
    await consume(transport, next);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toHaveProperty('previous_response_id');
    expect(requests[2]).not.toHaveProperty('previous_response_id');
    expect(requests[2].input).toEqual(next.input);
    expect(http).not.toHaveBeenCalled();
  });

  it('uses HTTP for the rest of the run after handshake failure', async () => {
    let attempts = 0;
    configureProviderWebSocket(() => {
      attempts++;
      const socket = new WebSocket(address.replace('ws:', 'http:') + '/reject');
      socket.on('error', () => {});
      queueMicrotask(() => socket.terminate());
      return socket as unknown as ProviderSocket;
    });
    const { transport, http } = setup();
    await consume(transport);
    await consume(transport);
    expect(attempts).toBe(1);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('passes partial-output disconnects upward and reconnects with full history on retry', async () => {
    const { transport, http } = setup();
    respond = (socket) => {
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
      socket.close();
    };
    await expect(consume(transport)).rejects.toThrow('流已中断');
    expect(http).not.toHaveBeenCalled();
    respond = (socket) => completed(socket);
    await consume(transport);
    expect(connections).toBe(2);
    expect(requests[1]).not.toHaveProperty('previous_response_id');
  });

  it('falls back with full input if the socket closes before any model output', async () => {
    const { transport, http } = setup();
    respond = (socket) => {
      socket.send(
        JSON.stringify({ type: 'response.created', response: { id: 'starting', output: [] } }),
      );
      socket.close();
    };
    const events = await consume(transport);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'response.completed', response: { id: 'http' } });
    expect(http).toHaveBeenCalledOnce();
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body)).input).toEqual(body().input);
  });

  it('passes explicit rate limits to normal retry handling without an extra HTTP request', async () => {
    const { transport, http } = setup();
    respond = (socket) =>
      socket.send(
        JSON.stringify({ type: 'error', status: 429, error: { code: 'rate_limit_exceeded' } }),
      );
    await expect(consume(transport)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limit_exceeded',
    });
    expect(http).not.toHaveBeenCalled();
  });

  it('closes cancelled requests without sending an HTTP fallback', async () => {
    const { transport, http } = setup();
    const controller = new AbortController();
    respond = () => controller.abort(new Error('cancelled'));
    await expect(consume(transport, body(), controller.signal)).rejects.toThrow('cancelled');
    expect(http).not.toHaveBeenCalled();
  });

  it('separates bindings and reconnects after OAuth credentials rotate', async () => {
    let token = 'fixture-a';
    const run = context();
    run.connection.provider = 'chatgpt';
    run.getSecret = async () =>
      JSON.stringify({
        client_id: 'client',
        subject: 'subject',
        issuer: OAUTH_ISSUER,
        ext_agent_host_id: 'host',
        access_token: token,
        id_token: 'fixture-id',
        token_type: 'Bearer',
        scopes: ['chatgpt.tokens.use.direct'],
        expires_at: Date.now() + 3600000,
      });
    run.saveSecret = async () => {};
    const { transport } = setup(undefined, run);
    await consume(transport);
    token = 'fixture-b';
    await consume(transport, body([...(body().input as unknown[]), ...output]));
    run.binding.id = 'another-binding';
    await consume(transport);
    expect(connections).toBe(3);
    expect(sessions).toEqual(['binding', 'binding', 'another-binding']);
    for (const request of requests) expect(request).not.toHaveProperty('previous_response_id');
  });

  it('reuses confirmed continuation across separate run wrappers with fresh cancellation', async () => {
    const pool = new ResponsesSessionPool();
    const old = new AbortController();
    const first = setup(undefined, { ...context(), signal: old.signal }, pool);
    await consume(first.transport);
    first.transport.close();
    old.abort();
    const next = body([
      ...(body().input as unknown[]),
      ...output,
      { role: 'user', content: 'next' },
    ]);
    const second = setup(undefined, context(), pool);
    await consume(second.transport, next);
    second.transport.close();
    expect(connections).toBe(1);
    expect(requests[1]).toMatchObject({
      previous_response_id: 'response',
      input: [{ role: 'user', content: 'next' }],
    });
    pool.close();
  });

  it('discards completed responses that have not been confirmed after persistence', async () => {
    const pool = new ResponsesSessionPool();
    const first = setup(undefined, context(), pool);
    for await (const _event of await first.transport.stream(body(), new AbortController().signal)) {
      /* deliberately not confirmed */
    }
    first.transport.close();
    const second = setup(undefined, context(), pool);
    await consume(second.transport, body([...(body().input as unknown[]), ...output]));
    expect(connections).toBe(2);
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    second.transport.close();
    pool.close();
  });

  it('allows nested runs on the same binding without sharing an active connection', async () => {
    const pool = new ResponsesSessionPool();
    const outer = setup(undefined, context(), pool);
    await consume(outer.transport);
    const inner = setup(undefined, context(), pool);
    await consume(inner.transport, { ...body(), instructions: 'summary' });
    inner.transport.close();
    const next = body([
      ...(body().input as unknown[]),
      ...output,
      { role: 'user', content: 'outer' },
    ]);
    await consume(outer.transport, next);
    outer.transport.close();
    const final = setup(undefined, context(), pool);
    await consume(
      final.transport,
      body([...(next.input as unknown[]), ...output, { role: 'user', content: 'final' }]),
    );
    expect(connections).toBe(2);
    expect(requests[2]).toHaveProperty('previous_response_id');
    expect(requests[3]).toHaveProperty('previous_response_id');
    final.transport.close();
    pool.close();
  });

  it('drops a cancelled lease before the next run and does not reuse its confirmed baseline', async () => {
    const pool = new ResponsesSessionPool(),
      controller = new AbortController();
    const first = setup(undefined, { ...context(), signal: controller.signal }, pool);
    await consume(first.transport);
    controller.abort();
    first.transport.close();
    const second = setup(undefined, context(), pool);
    await consume(second.transport, body([...(body().input as unknown[]), ...output]));
    expect(connections).toBe(2);
    expect(requests[1]).not.toHaveProperty('previous_response_id');
    second.transport.close();
    pool.close();
  });

  it('isolates binding generation, connection revision, and credentials between runs', async () => {
    const pool = new ResponsesSessionPool();
    const first = setup(undefined, context(), pool);
    await consume(first.transport);
    first.transport.close();
    const rotated = setup(undefined, context(), pool, 'rotated');
    await consume(rotated.transport, body([...(body().input as unknown[]), ...output]));
    rotated.transport.close();
    const different = context();
    different.binding.id = 'other';
    const other = setup(undefined, different, pool);
    await consume(other.transport);
    other.transport.close();
    const revised = context();
    revised.connection.revision = 2;
    const revision = setup(undefined, revised, pool);
    await consume(revision.transport);
    revision.transport.close();
    const restored = context();
    restored.binding.generation = 2;
    const generation = setup(undefined, restored, pool);
    await consume(generation.transport);
    generation.transport.close();
    expect(connections).toBe(5);
    for (const request of requests) expect(request).not.toHaveProperty('previous_response_id');
    pool.close();
  });

  it('keeps unknown custom API endpoints on HTTP with full input', async () => {
    const { transport, http } = setup('https://custom.example/v1');
    await consume(transport);
    expect(connections).toBe(0);
    expect(http).toHaveBeenCalledOnce();
    const request = JSON.parse(String(http.mock.calls[0]?.[1]?.body));
    expect(request.input).toEqual(body().input);
    expect(request).not.toHaveProperty('previous_response_id');
  });
});
