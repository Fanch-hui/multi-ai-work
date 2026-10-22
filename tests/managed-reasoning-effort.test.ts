import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ModelMessage, ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient } from '../src/providers/managed/client.js';
import { responsesInput } from '../src/providers/managed/messages.js';
import { appendReasoningUpdate } from '../src/providers/managed/reasoning-effort.js';
import { runManaged } from '../src/providers/managed/loop.js';
import {
  configureProviderFetch,
  configureProviderWebSocket,
  type ProviderSocket,
} from '../src/providers/network.js';
import { InterruptedModelStreamError } from '../src/providers/managed/request-errors.js';
import { compactRunMessages } from '../src/runtime/run-compaction.js';

beforeEach(() =>
  configureProviderWebSocket(() => {
    throw new InterruptedModelStreamError('fixture HTTP transport');
  }),
);
afterEach(() => {
  configureProviderFetch((input, init) => fetch(input, init));
  configureProviderWebSocket((url, headers) => {
    const socket = new WebSocket(url, { headers, followRedirects: false });
    socket.on('error', () => {});
    return socket as unknown as ProviderSocket;
  });
});

describe('managed Responses reasoning effort updates', () => {
  it('establishes the selected effort after successful compaction and retains archived updates', async () => {
    let request: Record<string, unknown> = {};
    configureProviderFetch(async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return streamResponse(1, []);
    });
    const context = createContext();
    context.bot.reasoning = 'high';
    context.messages = [
      { role: 'user', content: 'historical material '.repeat(1000) },
      { role: 'assistant', content: '', reasoningUpdate: { baseline: 'low', effort: 'low' } },
      { role: 'assistant', content: 'historical answer '.repeat(1000) },
    ];
    context.compactContext = (messages, { currentStart }) =>
      compactRunMessages(messages, {
        currentStart,
        force: true,
        budget: 16000,
        trigger: 1000,
        fixedTokens: 100,
        protocol: 'responses',
        signal: context.signal,
        summarize: async (prompt) => {
          expect(prompt).not.toContain('reasoningUpdate');
          return 'Earlier work completed.';
        },
      });
    const result = await runManaged(
      createClient('https://api.openai.com/v1'),
      context,
      'responses',
    );
    expect(request.reasoning).toEqual({ effort: 'high' });
    expect(
      result
        .contextMessages!.filter((message) => message.reasoningUpdate)
        .map((message) => message.reasoningUpdate),
    ).toEqual([{ baseline: 'high', effort: 'high' }]);
    expect(
      result
        .messages!.filter((message) => message.reasoningUpdate)
        .map((message) => message.reasoningUpdate),
    ).toEqual([
      { baseline: 'low', effort: 'low' },
      { baseline: 'high', effort: 'high' },
    ]);
  });

  it.each([
    { effort: 'none', updates: true, expected: 'low' },
    { effort: 'max', updates: true, expected: 'low' },
    { effort: 'provider-special', updates: false, expected: 'provider-special' },
    { effort: undefined, updates: true, expected: 'low' },
    { effort: undefined, defaultUnknown: true, updates: false, expected: undefined },
    { effort: 'high', customEndpoint: true, updates: false, expected: 'high' },
  ])('projects selected effort $effort with updates=$updates', async (scenario) => {
    let request: Record<string, unknown> = {};
    configureProviderFetch(async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return streamResponse(1, []);
    });
    const context = createContext();
    context.getReasoningEffort = () => scenario.effort;
    if (scenario.defaultUnknown) context.connection.models[0].defaultReasoningEffort = undefined;
    context.messages = [
      { role: 'user', content: 'previous' },
      { role: 'assistant', content: '', reasoningUpdate: { baseline: 'low', effort: 'high' } },
      { role: 'assistant', content: 'previous answer' },
    ];
    await runManaged(
      createClient(
        scenario.customEndpoint ? 'https://provider.example/v1' : 'https://api.openai.com/v1',
      ),
      context,
      'responses',
    );
    expect(request.reasoning).toEqual(
      scenario.expected ? { effort: scenario.expected } : undefined,
    );
    const updates = (request.input as { type?: string; reasoning?: { effort: string } }[]).filter(
      (item) => item.type === 'configuration_update',
    );
    expect(updates.length > 0).toBe(scenario.updates);
    if (scenario.updates)
      expect(updates.at(-1)!.reasoning!.effort).toBe(scenario.effort ?? 'medium');
  });

  it('keeps one baseline while applying low, high, and low at request boundaries', async () => {
    const requests: Record<string, unknown>[] = [];
    let effort = 'low';
    let toolCount = 0;
    configureProviderFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const index = requests.length;
      const output =
        index < 3
          ? [
              {
                type: 'function_call',
                call_id: `call-${index}`,
                name: 'advance',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'done',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done', annotations: [] }],
              },
            ];
      const event = {
        type: 'response.completed',
        response: {
          id: `response-${index}`,
          status: 'completed',
          output,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const context = createContext();
    context.getReasoningEffort = () => effort;
    context.executeTool = async () => {
      toolCount++;
      effort = toolCount === 1 ? 'high' : 'low';
      return 'ok';
    };

    const result = await runManaged(
      createClient('https://api.openai.com/v1'),
      context,
      'responses',
    );

    expect(result.text).toBe('done');
    expect(requests.map((request) => request.reasoning)).toEqual([
      { effort: 'low' },
      { effort: 'low' },
      { effort: 'low' },
    ]);
    expect(
      requests.map((request) =>
        (request.input as { type: string; reasoning?: { effort: string } }[])
          .filter((item) => item.type === 'configuration_update')
          .map((item) => item.reasoning?.effort),
      ),
    ).toEqual([['low'], ['low', 'high'], ['low', 'high', 'low']]);
    expect(result.contextMessages?.filter((message) => message.reasoningUpdate)).toEqual([
      { role: 'assistant', content: '', reasoningUpdate: { baseline: 'low', effort: 'low' } },
      { role: 'assistant', content: '', reasoningUpdate: { baseline: 'low', effort: 'high' } },
      { role: 'assistant', content: '', reasoningUpdate: { baseline: 'low', effort: 'low' } },
    ]);
  });

  it('filters trusted updates from unsupported request projections and ignores provider items', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: '',
        reasoningUpdate: { baseline: 'low', effort: 'high' },
      },
      {
        role: 'assistant',
        content: '',
        providerItems: [{ type: 'configuration_update', reasoning: { effort: 'xhigh' } }],
      },
    ];

    expect(responsesInput(messages)).toEqual([]);
    expect(responsesInput(messages, new Map(), true)).toEqual([
      { type: 'configuration_update', reasoning: { effort: 'high' } },
    ]);
  });

  it('keeps restored update markers and does not duplicate a retried request update', () => {
    const messages: ModelMessage[] = [];
    appendReasoningUpdate(messages, 'low', 'high');
    const restored = JSON.parse(JSON.stringify(messages)) as ModelMessage[];
    appendReasoningUpdate(restored, 'low', 'high');

    expect(restored).toEqual([
      { role: 'assistant', content: '', reasoningUpdate: { baseline: 'low', effort: 'high' } },
    ]);
    expect(responsesInput(restored, new Map(), true)).toEqual([
      { type: 'configuration_update', reasoning: { effort: 'high' } },
    ]);
  });

  it('persists the model default as the baseline before the first explicit update', async () => {
    const requests: Record<string, unknown>[] = [];
    let effort: string | undefined;
    configureProviderFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const index = requests.length;
      const output =
        index === 1
          ? [
              {
                type: 'function_call',
                call_id: 'call-1',
                name: 'advance',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'done',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done', annotations: [] }],
              },
            ];
      return streamResponse(index, output);
    });
    const context = createContext();
    context.getReasoningEffort = () => effort;
    context.executeTool = async () => {
      effort = 'high';
      return 'ok';
    };

    await runManaged(createClient('https://api.openai.com/v1'), context, 'responses');

    expect(requests[0]).toMatchObject({ reasoning: { effort: 'medium' } });
    expect((requests[0]!.input as { type: string }[]).at(-1)).toEqual({
      type: 'configuration_update',
      reasoning: { effort: 'medium' },
    });
    expect(requests[1]).toMatchObject({ reasoning: { effort: 'medium' } });
    expect(
      (requests[1]!.input as { type: string; reasoning?: { effort: string } }[]).at(-1),
    ).toEqual({
      type: 'configuration_update',
      reasoning: { effort: 'high' },
    });
  });

  it('uses request-level effort for unsupported model capability and preserves defaults', async () => {
    const requests: Record<string, unknown>[] = [];
    configureProviderFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const event = {
        type: 'response.completed',
        response: {
          id: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'done',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const context = createContext();
    context.connection.models[0]!.supportsReasoningEffortUpdates = false;
    context.bot.reasoning = 'low';

    await runManaged(createClient('https://api.openai.com/v1'), context, 'responses');

    expect(requests[0]).toMatchObject({ reasoning: { effort: 'low' } });
    expect(
      (requests[0]!.input as unknown[]).some(
        (item) => (item as { type?: string }).type === 'configuration_update',
      ),
    ).toBe(false);
  });
});

function createContext(): RunContext {
  const events: ProviderEvent[] = [];
  return {
    runId: 'reasoning-effort',
    bot: { id: 'bot', name: 'Bot', role: 'test', model: 'fixture' } as RunContext['bot'],
    connection: {
      id: 'connection',
      revision: 1,
      provider: 'custom',
      protocol: 'responses',
      authMode: 'none',
      baseUrl: 'https://api.openai.com/v1',
      models: [
        {
          id: 'fixture',
          name: 'Fixture',
          defaultReasoningEffort: 'medium',
          supportsReasoningEffortUpdates: true,
        },
      ],
    } as RunContext['connection'],
    binding: { id: 'binding', generation: 1 } as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'start',
    messages: [],
    instructions: 'system',
    tools: [{ name: 'advance', description: '', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: (event) => events.push(event),
    executeTool: async () => 'ok',
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
}

function streamResponse(index: number, output: unknown[]): Response {
  const event = {
    type: 'response.completed',
    response: {
      id: `response-${index}`,
      status: 'completed',
      output,
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
