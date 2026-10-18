import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { ModelActivity } from '../src/providers/activity.js';
import { chatTurn } from '../src/providers/managed/chat.js';
import { createClient } from '../src/providers/managed/client.js';
import { responsesTurn } from '../src/providers/managed/responses.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

async function fixture(streamEvents: unknown[]) {
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the local request body. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of streamEvents) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test server');
  const events: ProviderEvent[] = [];
  const context: RunContext = {
    runId: 'run', bot: { model: 'model' } as RunContext['bot'], connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: 'hi', messages: [], instructions: '',
    tools: [], signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} },
    emit: event => events.push(event), executeTool: async () => undefined,
    getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
  };
  return { client: createClient(`http://127.0.0.1:${address.port}`), context, events };
}
const kinds = (events: ProviderEvent[]) => events.filter(event => event.data.phase === 'model-activity').map(event => event.data.activityKind);
const chat = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

describe('provider model activity', () => {
  it('reports activity changes immediately and throttles repeated events without a timer heartbeat', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const events: ProviderEvent[] = [], activity = new ModelActivity(event => events.push(event));
    activity.report('waiting', 'created'); activity.report('thinking', 'reasoning');
    activity.report('thinking', 'reasoning');
    vi.advanceTimersByTime(5000);
    expect(kinds(events)).toEqual(['waiting', 'thinking']);
    activity.report('thinking', 'reasoning'); activity.report('tool', 'arguments'); activity.report('responding', 'text');
    expect(kinds(events)).toEqual(['waiting', 'thinking', 'thinking', 'tool', 'responding']);
    activity.reset(); activity.report('responding', 'text');
    expect(kinds(events).at(-1)).toBe('responding'); expect(events).toHaveLength(6);
  });

  it('distinguishes Chat reasoning, tool arguments and answer deltas without exposing reasoning', async () => {
    const { client, context, events } = await fixture([
      chat({ role: 'assistant' }), chat({ reasoning_content: 'private-thought' }),
      chat({ reasoning_content: 'more-private-thought' }),
      chat({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      chat({ content: 'Checking' }), chat({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    ]);
    const turn = await chatTurn(client, context, []);
    expect(kinds(events)).toEqual(['waiting', 'thinking', 'tool', 'responding', 'finishing']);
    expect(turn.message.content).toBe('Checking'); expect(turn.message.toolCalls).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('private-thought');
  });

  it('reports unknown Chat output as working while ignoring metadata-only trailing chunks', async () => {
    const { client, context, events } = await fixture([
      chat({ role: 'assistant' }), chat({ custom_output: 'opaque' }), chat({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    await chatTurn(client, context, []);
    expect(kinds(events)).toEqual(['waiting', 'working', 'finishing']);
  });

  it('distinguishes Responses lifecycle, reasoning, tool arguments and answer events', async () => {
    const output = { type: 'message', id: 'answer', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Done', annotations: [] }] };
    const { client, context, events } = await fixture([
      { type: 'response.created', response: { output: [] } },
      { type: 'response.in_progress', response: { output: [] } },
      { type: 'response.reasoning_text.delta', delta: 'private-thought' },
      { type: 'response.function_call_arguments.delta', delta: '{' },
      { type: 'response.output_text.delta', delta: 'Done', output_index: 0, content_index: 0, item_id: 'answer' },
      { type: 'response.completed', response: { status: 'completed', output: [output] } },
    ]);
    const turn = await responsesTurn(client, context, []);
    expect(kinds(events)).toEqual(['waiting', 'thinking', 'tool', 'responding']);
    expect(turn.message.content).toBe('Done'); expect(JSON.stringify(events)).not.toContain('private-thought');
  });
});
