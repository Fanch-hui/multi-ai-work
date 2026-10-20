import { describe, expect, it } from 'vitest';
import type { ManagedProgress, ProviderEvent, RunContext } from '../src/domain/provider.js';
import type { Protocol } from '../src/domain/types.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';

const call = {
  type: 'function_call',
  id: 'function',
  call_id: 'call',
  name: 'write',
  arguments: '{}',
  status: 'completed',
};
const output = {
  type: 'message',
  id: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: '完成', annotations: [] }],
};
const completed = (items: unknown[]) => ({
  type: 'response.completed',
  response: { id: 'response', status: 'completed', output: items },
});
const delta = {
  type: 'response.output_text.delta',
  output_index: 0,
  content_index: 0,
  item_id: 'message',
  delta: '未完成',
};
const chunk = (content: string, finish_reason: string | null) => ({
  id: 'chat',
  object: 'chat.completion.chunk',
  model: 'fixture',
  choices: [{ index: 0, delta: { content }, finish_reason }],
});

describe('Chromium model stream recovery', () => {
  it.each<Protocol>(['responses', 'chat-completions'])(
    'recovers an ERR_FAILED response body in %s after a successful write without repeating it',
    async (protocol) => {
      const initial =
        protocol === 'responses'
          ? completed([call])
          : {
              ...chunk('', 'tool_calls'),
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call',
                        type: 'function',
                        function: { name: 'write', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
      const f = fixture((index) => {
        if (index === 0) return { events: [initial] };
        if (index === 1)
          return { events: [protocol === 'responses' ? delta : chunk('未完成', null)], fail: true };
        return {
          events: [protocol === 'responses' ? completed([output]) : chunk('完成', 'stop')],
        };
      });
      let writes = 0;
      f.context.executeTool = async () => {
        writes++;
        return { written: true };
      };
      const result = await runManaged(f.client, f.context, protocol, [0]);
      expect(result.text).toBe('完成');
      expect(writes).toBe(1);
      expect(f.requests).toHaveLength(3);
      expect(f.requests[2]).toEqual(f.requests[1]);
      expect(result.messages).toContainEqual({
        role: 'tool',
        callId: 'call',
        content: '{"written":true}',
      });
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: 'text',
          data: expect.objectContaining({ delta: '未完成' }),
        }),
      );
      expect(f.events).toContainEqual({ type: 'text', data: { replace: '' } });
      expect(f.events.find((event) => event.data.phase === 'model-error')?.data).toMatchObject({
        code: 'ERR_FAILED',
        step: 2,
      });
      expect(f.events.find((event) => event.data.phase === 'model-retry')?.data).toMatchObject({
        code: 'ERR_FAILED',
        attempt: 1,
        maxAttempts: 5,
      });
      expect(f.saved.find((progress) => progress.recovery)?.phase).toBe('ready');
      expect(f.saved.find((progress) => progress.recovery)?.messages).toContainEqual({
        role: 'tool',
        callId: 'call',
        content: '{"written":true}',
      });
    },
  );

  it('saves confirmed readonly calls and their results before recovering ERR_FAILED', async () => {
    const read = { ...call, name: 'read' };
    const reasoning = {
      type: 'reasoning',
      id: 'reasoning',
      summary: [],
      encrypted_content: 'fixture-opaque',
    };
    const f = fixture((index) => ({
      events:
        index === 0
          ? [
              { type: 'response.output_item.done', output_index: 0, item: reasoning },
              { type: 'response.output_item.done', output_index: 1, item: read },
              { ...delta, output_index: 2 },
            ]
          : [completed([output])],
      fail: index === 0,
    }));
    f.context.tools = [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }];
    f.context.parallelToolNames = ['read'];
    let reads = 0;
    f.context.executeTool = async () => {
      reads++;
      return { read: true };
    };
    const result = await runManaged(f.client, f.context, 'responses', [0]);
    expect(result.text).toBe('完成');
    expect(reads).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].input).toEqual([
      { role: 'user', content: 'go' },
      reasoning,
      read,
      { type: 'function_call_output', call_id: 'call', output: '{"read":true}' },
    ]);
    expect(f.saved.some((progress) => progress.earlyFailures === 1)).toBe(true);
    expect(f.saved.at(-1)?.earlyFailures).toBe(0);
  });

  it('stops after five retries of an ERR_FAILED response body', async () => {
    const f = fixture(() => ({ events: [delta], fail: true }));
    await expect(runManaged(f.client, f.context, 'responses', [0, 0, 0, 0, 0, 0])).rejects.toThrow(
      'net::ERR_FAILED',
    );
    expect(f.requests).toHaveLength(6);
    expect(
      f.events
        .filter((event) => event.data.phase === 'model-retry')
        .map((event) => event.data.attempt),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(f.saved.at(-1)?.attempt).toBe(5);
  });
});

function fixture(handler: (index: number) => { events: unknown[]; fail?: boolean }) {
  const requests: Record<string, unknown>[] = [];
  const events: ProviderEvent[] = [];
  const saved: ManagedProgress[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const index = requests.push(JSON.parse(String(init?.body))) - 1;
    const result = handler(index);
    const data = new TextEncoder().encode(
      result.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    );
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(data);
          } else if (result.fail) {
            controller.error(new TypeError('net::ERR_FAILED'));
          } else controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const context: RunContext = {
    runId: 'run',
    bot: { model: 'fixture' } as RunContext['bot'],
    connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'go',
    messages: [],
    instructions: 'Help',
    tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: (event) => {
      events.push(event);
    },
    executeTool: async () => ({}),
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
    saveProgress: async (progress) => {
      saved.push(structuredClone(progress));
    },
  };
  return {
    client: createClient('http://127.0.0.1/v1', undefined, fetcher),
    context,
    requests,
    events,
    saved,
  };
}
