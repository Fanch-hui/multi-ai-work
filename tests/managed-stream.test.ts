import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelMessage, ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const answer = 'Hi! 你好，有什么我可以帮助你的吗?';
const output = (text = answer) => ({
  type: 'message',
  id: 'message1',
  status: 'completed',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const terminal = (items: unknown[], type = 'response.completed', status = 'completed') => ({
  type,
  response: {
    id: 'response1',
    status,
    output: items,
    error: { code: 'server_error' },
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { input_tokens: 1114, output_tokens: 15 },
  },
});
const delta = (text = answer) => ({
  type: 'response.output_text.delta',
  output_index: 1,
  content_index: 0,
  item_id: 'message1',
  delta: text,
});
const done = (item: unknown, index: number) => ({
  type: 'response.output_item.done',
  output_index: index,
  item,
});

describe('managed protocol completion and retained answers', () => {
  it('compares completed Responses requests across a tool round and a failed retry', async () => {
    const call = {
      type: 'function_call',
      id: 'function1',
      call_id: 'call1',
      name: 'read',
      arguments: '{}',
      status: 'completed',
    };
    const server = await fixture((_request, index) => {
      if (index === 1) return [terminal([], 'response.failed', 'failed')];
      const event = terminal(index === 0 ? [call] : [output()]);
      return [
        {
          ...event,
          response: {
            ...event.response,
            id: `resp_${index}`,
            model: 'gpt-6.1-sol',
            prompt_cache_diagnostics: index === 0 ? undefined : { type: 'cache_hit' },
            usage: {
              ...event.response.usage,
              input_tokens_details: { cached_tokens: index === 0 ? 0 : 1024 },
            },
          },
        },
      ];
    });
    const events: ProviderEvent[] = [];
    const result = await runManaged(
      createClient(server.url),
      {
        ...context(events),
        connection: { provider: 'chatgpt' } as RunContext['connection'],
        bot: { model: 'gpt-6.1-sol' } as RunContext['bot'],
        tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
      },
      'responses',
      [0],
    );
    expect(server.requests[0]).not.toHaveProperty('prompt_cache_options');
    expect(server.requests.slice(1).map((request) => request.prompt_cache_options)).toEqual([
      { comparison_response_id: 'resp_0' },
      { comparison_response_id: 'resp_0' },
    ]);
    const requests = events.filter((event) => event.data.phase === 'model-cache-request');
    expect(requests.map((event) => event.data.requestId)).toEqual(['run:1', 'run:2', 'run:3']);
    expect(requests[2].data).toMatchObject({
      baselineRequestId: 'run:1',
      inputPrefixUnchanged: true,
      changedFields: [],
    });
    const responses = events.filter((event) => event.data.phase === 'model-cache-response');
    expect(responses.map((event) => event.data.responseId)).toEqual(['resp_0', 'resp_2']);
    expect(responses[1].data.diagnostics).toEqual({ type: 'cache_hit' });
    expect(result.usage).toMatchObject({ inputTokens: 2228, cachedInputTokens: 1024 });
    expect(events.filter((event) => event.data.phase === 'model-response')).toHaveLength(2);
  });

  it('uses official completed output without a convenience output_text property', async () => {
    const server = await fixture(() => [delta(), terminal([output()])]);
    const events: ProviderEvent[] = [];
    const result = await runManaged(createClient(server.url), context(events), 'responses');
    expect(result.text).toBe(answer);
    expect(result.messages?.at(-1)?.content).toBe(answer);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', data: { delta: answer, messageKey: 'run:1:message1' } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 1114, outputTokens: 15, source: 'reported' });
  });

  it('retains completed stream items when terminal output is empty and resends them once', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'reason1',
      encrypted_content: 'opaque-fixture',
      summary: [],
    };
    const server = await fixture((_request, index) =>
      index === 0
        ? [
            done(reasoning, 0),
            {
              type: 'response.output_item.added',
              output_index: 1,
              item: { ...output(''), status: 'in_progress', content: [] },
            },
            delta('Hi! '),
            delta('你好，有什么我可以帮助你的吗?'),
            {
              type: 'response.output_text.done',
              item_id: 'message1',
              output_index: 1,
              content_index: 0,
              text: answer,
            },
            done(output(), 1),
            terminal([]),
          ]
        : [terminal([output('继续为你工作。')])],
    );
    const first = await runManaged(createClient(server.url), context([]), 'responses');
    expect(first.text).toBe(answer);
    expect(first.messages?.at(-1)?.providerItems).toEqual([reasoning, output()]);
    const next = await runManaged(
      createClient(server.url),
      { ...context([]), prompt: '继续', messages: first.messages! },
      'responses',
    );
    expect(next.text).toBe('继续为你工作。');
    expect(server.requests[1].input).toEqual([
      { role: 'user', content: 'hi' },
      reasoning,
      output(),
      { role: 'user', content: '继续' },
    ]);
  });

  it.each([{ content: [] }, { content: output('').content }])(
    'restores completed text parts with terminal content $content',
    async ({ content }) => {
      const server = await fixture(() => [
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { ...output(''), status: 'in_progress', content: [] },
        },
        delta(),
        {
          type: 'response.content_part.done',
          output_index: 1,
          content_index: 0,
          item_id: 'message1',
          part: output().content[0],
        },
        terminal([{ ...output(''), content }]),
      ]);
      const result = await runManaged(createClient(server.url), context([]), 'responses');
      expect(result.text).toBe(answer);
      expect(result.messages?.at(-1)?.providerItems).toEqual([output()]);
    },
  );

  it.each([
    ['truncated', [delta()], 'response.completed'],
    ['failed', [delta(), terminal([], 'response.failed', 'failed')], 'server_error'],
    [
      'incomplete',
      [delta(), terminal([], 'response.incomplete', 'incomplete')],
      'max_output_tokens',
    ],
    [
      'error event',
      [delta(), { type: 'error', code: 'token_expired', message: 'fixture-error' }],
      '模型返回错误事件',
    ],
    ['cancelled', [delta(), terminal([], 'response.completed', 'cancelled')], '模型终态无效'],
    [
      'incomplete item',
      [delta(), terminal([{ ...output(), status: 'incomplete' }])],
      '模型输出条目未完成',
    ],
  ])('rejects %s responses despite visible text', async (_label, events, error) => {
    const server = await fixture(() => events as unknown[]);
    const emitted: ProviderEvent[] = [];
    await expect(
      runManaged(createClient(server.url), context(emitted), 'responses', []),
    ).rejects.toThrow(error as string);
    expect(emitted.some((event) => event.type === 'text')).toBe(true);
    expect(server.requests).toHaveLength(1);
  });

  it('does not accept an unfinished tool item from a terminal with an empty output', async () => {
    const server = await fixture(() => [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'function1',
          call_id: 'call1',
          name: 'write',
          arguments: '{}',
          status: 'in_progress',
        },
      },
      terminal([]),
    ]);
    let writes = 0;
    await expect(
      runManaged(
        createClient(server.url),
        {
          ...context([]),
          executeTool: async () => {
            writes++;
          },
        },
        'responses',
      ),
    ).rejects.toThrow('缺少完成事件');
    expect(writes).toBe(0);
  });

  it('honors local cancellation after text even if a completion follows', async () => {
    const server = await fixture(() => [delta(), terminal([output()])]);
    const controller = new AbortController();
    const run = {
      ...context([]),
      signal: controller.signal,
      emit: (event: ProviderEvent) => {
        if (event.type === 'text') controller.abort(new Error('cancel-fixture'));
      },
    };
    await expect(runManaged(createClient(server.url), run, 'responses')).rejects.toThrow();
  });

  it.each([true, false])(
    'records model steps and reports cache only when all steps report it (%s)',
    async (completeCache) => {
      const call = {
        type: 'function_call',
        id: 'function1',
        call_id: 'call1',
        name: 'read',
        arguments: '{}',
        status: 'completed',
      };
      const server = await fixture((_request, index) => {
        const event = terminal(index === 0 ? [call] : [output()]);
        return [
          {
            ...event,
            response: {
              ...event.response,
              usage: {
                ...event.response.usage,
                input_tokens_details:
                  index === 0 || completeCache ? { cached_tokens: index === 0 ? 512 : 256 } : {},
              },
            },
          },
        ];
      });
      const events: ProviderEvent[] = [];
      const result = await runManaged(
        createClient(server.url),
        {
          ...context(events),
          tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
        },
        'responses',
      );
      expect(result.usage).toMatchObject({
        inputTokens: 2228,
        outputTokens: 30,
        source: 'reported',
      });
      expect(result.usage?.cachedInputTokens).toBe(completeCache ? 768 : undefined);
      expect(
        events
          .filter((event) => event.type === 'status' && event.data.phase === 'model-request')
          .map((event) => event.data),
      ).toEqual([
        { phase: 'model-request', step: 1, requestId: 'run:1' },
        { phase: 'model-request', step: 2, requestId: 'run:2' },
      ]);
      const timings = events.filter(
        (event) => event.type === 'status' && event.data.phase === 'model-response',
      );
      expect(timings.map((event) => event.data.step)).toEqual([1, 2]);
      expect(timings.map((event) => event.data.usage)).toEqual([
        { inputTokens: 1114, outputTokens: 15, cachedInputTokens: 512, source: 'reported' },
        {
          inputTokens: 1114,
          outputTokens: 15,
          ...(completeCache ? { cachedInputTokens: 256 } : {}),
          source: 'reported',
        },
      ]);
      expect(result.modelDurationMs).toBe(
        timings.reduce((total, event) => total + Number(event.data.durationMs), 0),
      );
    },
  );

  it.each([true, false])(
    'keeps zero request usage distinct from missing usage (%s)',
    async (reportUsage) => {
      const server = await fixture(() => [
        chat(answer),
        chat(null, 'stop'),
        ...(reportUsage
          ? [
              {
                choices: [],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  prompt_tokens_details: { cached_tokens: 0 },
                },
              },
            ]
          : []),
      ]);
      const events: ProviderEvent[] = [];
      await runManaged(createClient(server.url), context(events), 'chat-completions');
      const response = events.find(
        (event) => event.type === 'status' && event.data.phase === 'model-response',
      )!;
      expect(response.data.requestId).toBe('run:1');
      if (reportUsage)
        expect(response.data.usage).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          source: 'reported',
        });
      else expect(response.data).not.toHaveProperty('usage');
    },
  );

  it('retains Chat Completions content and history only after a successful finish reason', async () => {
    const server = await fixture(() => [
      chat(answer),
      chat(null, 'stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 1114,
          completion_tokens: 15,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      },
    ]);
    const first = await runManaged(createClient(server.url), context([]), 'chat-completions');
    expect(first.text).toBe(answer);
    expect(first.usage?.cachedInputTokens).toBe(64);
    const next = await runManaged(
      createClient(server.url),
      { ...context([]), messages: first.messages!, prompt: '继续' },
      'chat-completions',
    );
    expect(next.text).toBe(answer);
    expect(server.requests[1].messages).toEqual([
      { role: 'system', content: 'Help' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: answer },
      { role: 'user', content: '继续' },
    ]);
  });

  it.each([null, 'length', 'content_filter'])(
    'rejects Chat streams with finish reason %s',
    async (reason) => {
      const server = await fixture(() => [chat(answer), ...(reason ? [chat(null, reason)] : [])]);
      await expect(
        runManaged(createClient(server.url), context([]), 'chat-completions', []),
      ).rejects.toThrow('模型响应未完成');
    },
  );
});

function chat(content: string | null, finishReason: string | null = null) {
  return {
    id: 'chat1',
    object: 'chat.completion.chunk',
    model: 'fixture',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}
async function fixture(events: (request: Record<string, unknown>, index: number) => unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as Record<string, unknown>;
    const index = requests.push(payload) - 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      events(payload, index)
        .map(
          (event, sequence_number) =>
            `data: ${JSON.stringify({ sequence_number, ...(event as object) })}\n\n`,
        )
        .join(''),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}
function context(events: ProviderEvent[], messages: ModelMessage[] = []): RunContext {
  return {
    runId: 'run',
    bot: { model: 'fixture' } as RunContext['bot'],
    connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'hi',
    messages,
    instructions: 'Help',
    tools: [],
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: (event) => {
      events.push(event);
    },
    executeTool: async () => 'done',
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
}
