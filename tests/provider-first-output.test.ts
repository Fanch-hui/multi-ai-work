import type OpenAI from 'openai';
import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { chatTurn } from '../src/providers/managed/chat.js';
import { responsesTurn } from '../src/providers/managed/responses.js';
import { AntigravityEvents } from '../src/providers/native/antigravity-events.js';
import { QoderEvents } from '../src/providers/native/qoder-events.js';

const started = (events: ProviderEvent[]) =>
  events.filter((event) => event.data.phase === 'model-work-started');
const chat = (delta: unknown, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});
const answer = {
  type: 'message',
  id: 'answer',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Done', annotations: [] }],
};
const completed = (output: unknown[] = [answer]) => ({
  type: 'response.completed',
  response: { status: 'completed', output },
});

function fixture(packets: unknown[]) {
  const events: ProviderEvent[] = [];
  const counts: number[] = [];
  const requests: unknown[] = [];
  const create = async (body: unknown) => {
    requests.push(body);
    return (async function* () {
      for (const packet of packets) {
        yield packet;
        counts.push(started(events).length);
      }
    })();
  };
  const client = {
    chat: { completions: { create } },
    responses: { create },
  } as unknown as OpenAI;
  const context: RunContext = {
    runId: 'run',
    bot: { model: 'model' } as RunContext['bot'],
    connection: {} as RunContext['connection'],
    binding: { id: 'binding', generation: 1 } as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'hello',
    messages: [],
    instructions: 'instructions',
    tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal,
    emit: (event: ProviderEvent) => events.push(event),
    nativeMcp: { command: '', args: [], env: {} },
    executeTool: async () => undefined,
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
  return { client, context, events, counts, requests };
}

describe('provider first actual model output', () => {
  it.each([
    { reasoning_content: 'thought' },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted' }] },
    { content: 'answer' },
  ])('marks real Chat output once across further requests: %j', async (delta) => {
    const run = fixture([
      chat({ role: 'assistant' }),
      chat({ content: '', reasoning_content: '', reasoning_details: [] }),
      chat(delta),
      chat({ content: 'Done' }),
      chat({}, 'stop'),
    ]);
    await chatTurn(run.client, run.context, []);
    await chatTurn(run.client, { ...run.context }, []);
    expect(run.counts.slice(0, 4)).toEqual([0, 0, 1, 1]);
    expect(started(run.events)).toEqual([
      { type: 'status', data: { phase: 'model-work-started' } },
    ]);
    expect(run.requests[0]).toEqual(run.requests[1]);
    await chatTurn(run.client, { ...run.context, runId: 'next-run' }, []);
    expect(started(run.events)).toHaveLength(2);
  });

  it('ignores unknown metadata, empty reasoning and usage without changing partial-output timing', async () => {
    const run = fixture([
      chat({ role: 'assistant' }),
      chat({ custom_output: 'opaque' }),
      chat({ reasoning_details: [{ type: 'reasoning.text', text: '' }] }),
      chat({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } },
    ]);
    await chatTurn(run.client, run.context, []);
    expect(started(run.events)).toEqual([]);
    expect(run.events.some((event) => event.data.stage === 'model-first-output')).toBe(true);
  });

  it('recognizes Chat tool names after empty tool fragments', async () => {
    const run = fixture([
      chat({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: {} }] }),
      chat({ tool_calls: [{ index: 0, function: { name: 'read', arguments: '{}' } }] }),
      chat({}, 'tool_calls'),
    ]);
    const result = await chatTurn(run.client, run.context, []);
    expect(run.counts.slice(0, 2)).toEqual([0, 1]);
    expect(result.message.toolCalls).toEqual([{ id: 'call', name: 'read', arguments: '{}' }]);
  });

  it.each([
    { type: 'response.reasoning_text.delta', delta: 'thought' },
    { type: 'response.function_call_arguments.delta', delta: '{' },
    {
      type: 'response.output_text.done',
      text: 'Done',
      output_index: 0,
      content_index: 0,
      item_id: 'answer',
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'tool', call_id: 'call', name: 'read', arguments: '' },
    },
  ])('marks actual Responses output and ignores structural events: $type', async (actual) => {
    const run = fixture([
      { type: 'response.created', response: { output: [] } },
      { type: 'response.in_progress', response: { output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...answer, content: [] } },
      { type: 'response.reasoning_text.delta', delta: '' },
      { type: 'response.function_call_arguments.delta', delta: '' },
      actual,
      completed(),
    ]);
    await responsesTurn(run.client, run.context, []);
    expect(run.counts.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(started(run.events)).toHaveLength(1);
    await responsesTurn(run.client, { ...run.context }, []);
    expect(started(run.events)).toHaveLength(1);
    expect(run.requests[0]).toEqual(run.requests[1]);
  });

  it('recognizes completed-only Responses output and excludes empty completed output', async () => {
    const empty = fixture([completed([])]);
    await responsesTurn(empty.client, empty.context, []);
    expect(started(empty.events)).toHaveLength(0);
    const run = fixture([completed()]);
    await responsesTurn(run.client, run.context, []);
    expect(started(run.events)).toHaveLength(1);
  });

  it('keeps summary events separate from front model events with the same cancellation signal', async () => {
    const run = fixture([completed()]);
    const summary: ProviderEvent[] = [];
    await responsesTurn(
      run.client,
      {
        ...run.context,
        runId: 'run:summary:1',
        emit: (event) => summary.push(event),
      },
      [],
    );
    await responsesTurn(run.client, run.context, []);
    expect(started(summary)).toHaveLength(1);
    expect(started(run.events)).toHaveLength(1);
  });

  it.each(['thinking_delta', 'input_json_delta', 'text_delta'])(
    'handles Qoder %s and keeps the marker across beginReply',
    (type) => {
      const run = fixture([]),
        projection = new QoderEvents(run.context);
      const accept = (event: unknown) =>
        projection.accept({ type: 'stream_event', event } as SDKMessage);
      accept({ type: 'message_start' });
      accept({
        type: 'content_block_delta',
        delta: { type, text: '', thinking: '', partial_json: '' },
      });
      expect(started(run.events)).toHaveLength(0);
      accept({
        type: 'content_block_delta',
        delta: { type, text: 'text', thinking: 'thought', partial_json: '{' },
      });
      projection.beginReply();
      accept({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'more' } });
      expect(started(run.events)).toHaveLength(1);
      expect(JSON.stringify(started(run.events))).not.toContain('thought');
    },
  );

  it('recognizes Qoder tool-only output', () => {
    const run = fixture([]),
      projection = new QoderEvents(run.context);
    projection.accept({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
    } as SDKMessage);
    expect(started(run.events)).toHaveLength(1);
  });

  it.each(['text', 'tool'])(
    'marks Antigravity %s once across turns without counting generic activity',
    (kind) => {
      const events: ProviderEvent[] = [];
      const projection = new AntigravityEvents({ emit: (event) => events.push(event) });
      projection.accept({
        event: 'init',
        conversation_id: 'session',
        init: { cwd: '/workspace', tools: [], permission_mode: 'request-review' },
      });
      const step = (extra: object) => ({
        event: 'step_update',
        step_update: { conversation_id: 'session', step_index: 0, state: 'ACTIVE', ...extra },
      });
      projection.accept(step({ step_type: 'agent_response', text_delta: '' }));
      projection.accept(step({ step_type: 'checkpoint', usage: { input_tokens: 1 } }));
      expect(started(events)).toHaveLength(0);
      projection.accept(
        step(
          kind === 'text'
            ? { step_type: 'agent_response', text_delta: 'answer' }
            : { step_type: 'tool', tool_name: 'read' },
        ),
      );
      projection.nextTurn();
      projection.accept(step({ step_type: 'agent_response', text_delta: 'more' }));
      expect(started(events)).toHaveLength(1);
    },
  );
});
