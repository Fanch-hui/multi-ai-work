import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ChatReasoningField,
  ModelMessage,
  ProviderEvent,
  RunContext,
} from '../src/domain/provider.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { chatInput } from '../src/providers/managed/messages.js';
import { ChatReplayCompatibility } from '../src/providers/managed/chat-replay-compatibility.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';
import { requestManagedTurn } from '../src/providers/managed/loop-request.js';

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

describe('Chat Completions continuation replay', () => {
  it.each(['reasoning_content', 'reasoning', 'reasoning_text'] as const)(
    'persists and replays %s across user turns without exposing it',
    async (field) => {
      const fixture = await server(() => [
        chunk({ [field]: 'private ' }),
        chunk({ [field]: 'thought' }),
        ...answer(),
      ]);
      const events: ProviderEvent[] = [];
      const first = await runManaged(
        createClient(fixture.url),
        context(events),
        'chat-completions',
      );
      expect(first.messages?.at(-1)?.chatReplay).toEqual({
        version: 1,
        bindingId: 'binding',
        generation: 1,
        reasoningField: field,
        reasoningText: 'private thought',
      });
      expect(events.filter((event) => event.type === 'text')).toEqual([
        { type: 'text', data: { delta: 'answer', messageKey: 'run:1' } },
      ]);
      const messages = JSON.parse(JSON.stringify(first.messages)) as ModelMessage[];
      await runManaged(
        createClient(fixture.url),
        { ...context([]), messages, prompt: 'next' },
        'chat-completions',
      );
      expect(fixture.requests[1].messages).toContainEqual({
        role: 'assistant',
        content: 'answer',
        [field]: 'private thought',
      });
      expect(chatInput(messages, 'system')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ [field]: expect.anything() })]),
      );
      expect(
        chatInput(messages, 'system', undefined, { bindingId: 'other', generation: 1 }),
      ).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ [field]: expect.anything() })]),
      );
      expect(
        chatInput(messages, 'system', undefined, { bindingId: 'binding', generation: 2 }),
      ).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ [field]: expect.anything() })]),
      );
    },
  );

  it('uses one reasoning alias and retains ordinary old messages unchanged', async () => {
    const fixture = await server(() => [
      chunk({ reasoning_content: 'one', reasoning: 'duplicate' }),
      chunk({ reasoning_content: ' two', reasoning: ' duplicate' }),
      ...answer(),
    ]);
    const result = await runManaged(createClient(fixture.url), context([]), 'chat-completions');
    expect(result.messages?.at(-1)?.chatReplay?.reasoningText).toBe('one two');
    expect(
      chatInput(result.messages!, '', undefined, { bindingId: 'binding', generation: 1 }).at(-1),
    ).toEqual({ role: 'assistant', content: 'answer', reasoning_content: 'one two' });
    expect(
      chatInput([{ role: 'assistant', content: 'old' }], '', undefined, {
        bindingId: 'binding',
        generation: 1,
      }),
    ).toEqual([
      { role: 'system', content: '' },
      { role: 'assistant', content: 'old' },
    ]);
    const ordinary = await server(() => answer());
    const plain = await runManaged(createClient(ordinary.url), context([]), 'chat-completions');
    expect(plain.messages?.at(-1)).not.toHaveProperty('chatReplay');
  });

  it('prefers structured reasoning, merges matching text deltas, and keeps opaque items discrete', async () => {
    const fixture = await server(() => [
      chunk({
        reasoning: 'duplicate plaintext',
        reasoning_details: [
          { type: 'reasoning.text', id: 'r1', index: 0, text: 'one', signature: 'signature' },
        ],
      }),
      chunk({
        reasoning_details: [
          { type: 'reasoning.text', id: 'r1', index: 0, text: ' two', signature: null },
        ],
      }),
      chunk({
        reasoning_details: [
          { type: 'reasoning.text', id: 'r2', index: 1, text: 'separate' },
          { type: 'reasoning.summary', id: 's1', summary: 'sum' },
        ],
      }),
      chunk({
        reasoning_details: [
          { type: 'reasoning.summary', id: 's1', summary: 'mary' },
          { type: 'reasoning.encrypted', id: 'e1', data: 'opaque-1', format: 'native' },
          { type: 'reasoning.encrypted', id: 'e1', data: 'opaque-2', format: 'native' },
        ],
      }),
      ...answer(),
    ]);
    const first = await runManaged(createClient(fixture.url), context([]), 'chat-completions');
    const expected = [
      { type: 'reasoning.text', id: 'r1', index: 0, text: 'one two', signature: 'signature' },
      { type: 'reasoning.text', id: 'r2', index: 1, text: 'separate' },
      { type: 'reasoning.summary', id: 's1', summary: 'summary' },
      { type: 'reasoning.encrypted', id: 'e1', data: 'opaque-1', format: 'native' },
      { type: 'reasoning.encrypted', id: 'e1', data: 'opaque-2', format: 'native' },
    ];
    expect(first.messages?.at(-1)?.chatReplay?.reasoningDetails).toEqual(expected);
    await runManaged(
      createClient(fixture.url),
      { ...context([]), messages: first.messages!, prompt: 'next' },
      'chat-completions',
    );
    expect(fixture.requests[1].messages).toContainEqual({
      role: 'assistant',
      content: 'answer',
      reasoning_details: expected,
    });
  });

  it('saves complete reasoning and tool calls before executing tools and recovers the saved tool phase', async () => {
    const fixture = await server((_body, index) =>
      index === 0
        ? [
            chunk({ reasoning_text: 'tool thought' }),
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c1',
                    type: 'function',
                    function: { name: 'read', arguments: '{}' },
                  },
                ],
              },
              'tool_calls',
            ),
          ]
        : answer(),
    );
    let saved: RunContext['progress'];
    const run = {
      ...context([]),
      tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
      saveProgress: async (progress: NonNullable<RunContext['progress']>) => {
        saved = structuredClone(progress);
      },
      executeTool: async () => {
        expect(saved?.phase).toBe('tools');
        expect(saved?.messages.at(-1)?.chatReplay?.reasoningText).toBe('tool thought');
        throw new Error('restart fixture');
      },
    };
    await expect(runManaged(createClient(fixture.url), run, 'chat-completions')).rejects.toThrow(
      'restart fixture',
    );
    await runManaged(
      createClient(fixture.url),
      { ...run, progress: saved, executeTool: async () => 'tool result' },
      'chat-completions',
    );
    expect(fixture.requests[1].messages).toContainEqual({
      role: 'assistant',
      content: null,
      reasoning_text: 'tool thought',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    });
    expect(fixture.requests[1].messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'tool result',
    });
  });

  it('does not save a partial assistant or its reasoning', async () => {
    const fixture = await server(() => [
      chunk({ reasoning: 'unfinished' }),
      chunk({ content: 'partial' }),
    ]);
    let saved: RunContext['progress'];
    await expect(
      runManaged(
        createClient(fixture.url),
        {
          ...context([]),
          saveProgress: async (progress) => {
            saved = structuredClone(progress);
          },
        },
        'chat-completions',
        [],
      ),
    ).rejects.toThrow('流中断');
    expect(saved?.messages.some((message) => message.role === 'assistant')).toBe(false);
  });
});

describe('Chat replay field compatibility', () => {
  it('retries one explicitly rejected field with a new request ID and remembers only that model/connection revision', async () => {
    const fixture = await server((body) =>
      body.messages.some((message) => 'reasoning_content' in message)
        ? {
            error: {
              message: "Unknown parameter: 'messages[1].reasoning_content'",
              param: 'messages[1].reasoning_content',
            },
          }
        : answer(),
    );
    const cache = new ChatReplayCompatibility();
    const events: ProviderEvent[] = [];
    const run = { ...context(events), messages: [history()] };
    await turn(fixture.url, run, cache);
    expect(fixture.requests).toHaveLength(2);
    expect(
      events
        .filter((event) => event.data.phase === 'model-request')
        .map((event) => event.data.requestId),
    ).toEqual(['run:1', 'run:2']);
    expect(events.filter((event) => event.data.phase === 'model-error')).toHaveLength(1);
    await turn(fixture.url, { ...run, runId: 'next' }, cache);
    expect(fixture.requests).toHaveLength(3);
    const changed = { ...run, connection: { ...run.connection, revision: 2 } };
    await turn(fixture.url, changed, cache);
    expect(fixture.requests).toHaveLength(5);
    expect(cache.fields({ ...run, bot: { ...run.bot, model: 'other-model' } }).size).toBe(0);
  });

  it.each(['reasoning_details', 'reasoning', 'reasoning_text'] as const)(
    'downgrades an explicitly unsupported %s field',
    async (field) => {
      const fixture = await server((body) =>
        body.messages.some((message) => field in message)
          ? { error: { message: `Unsupported parameter: ${field}`, param: field } }
          : answer(),
      );
      const message = history(field === 'reasoning_details' ? 'reasoning' : field);
      if (field === 'reasoning_details')
        message.chatReplay!.reasoningDetails = [{ type: 'reasoning.encrypted', data: 'opaque' }];
      await turn(
        fixture.url,
        { ...context([]), messages: [message] },
        new ChatReplayCompatibility(),
      );
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1].messages[1]).not.toHaveProperty(field);
    },
  );

  it.each([
    'reasoning_content is required',
    'Unknown parameter: tools',
    'Invalid reasoning_content value',
    'Unknown model while processing reasoning_content',
  ])('does not downgrade other request errors: %s', async (message) => {
    const fixture = await server(() => ({ error: { message } }));
    await expect(
      turn(fixture.url, { ...context([]), messages: [history()] }, new ChatReplayCompatibility()),
    ).rejects.toThrow(message);
    expect(fixture.requests).toHaveLength(1);
  });

  it('only downgrades once when a turn contains multiple field formats', async () => {
    const fixture = await server((body) => ({
      error: {
        message: `Unknown parameter: ${body.messages.some((message) => 'reasoning_content' in message) ? 'reasoning_content' : 'reasoning_text'}`,
      },
    }));
    await expect(
      turn(
        fixture.url,
        { ...context([]), messages: [history(), history('reasoning_text')] },
        new ChatReplayCompatibility(),
      ),
    ).rejects.toThrow('reasoning_text');
    expect(fixture.requests).toHaveLength(2);
  });

  it('never remembers a rejection after output or for an unsent field', () => {
    const cache = new ChatReplayCompatibility();
    const error = { status: 400, message: 'Unsupported parameter: reasoning_content' };
    expect(cache.reject({ ...error, partialOutput: true }, context([]), [history()])).toBe(false);
    expect(cache.reject(error, context([]), [history('reasoning')])).toBe(false);
    expect(cache.reject({ ...error, status: 503 }, context([]), [history()])).toBe(false);
    expect(cache.fields(context([])).size).toBe(0);
  });
});

function history(field: ChatReasoningField = 'reasoning_content'): ModelMessage {
  return {
    role: 'assistant',
    content: 'old',
    chatReplay: {
      version: 1,
      bindingId: 'binding',
      generation: 1,
      reasoningField: field,
      reasoningText: 'hidden',
    },
  };
}
function chunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason }] };
}
function answer() {
  return [
    chunk({ content: 'answer' }, 'stop'),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ];
}
interface Body {
  messages: Record<string, unknown>[];
}
async function server(
  reply: (body: Body, index: number) => unknown[] | { error: { message: string; param?: string } },
) {
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const part of request) text += part;
    const body = JSON.parse(text) as Body;
    const result = reply(body, requests.push(body) - 1);
    if (!Array.isArray(result)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      result.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}
function context(events: ProviderEvent[]): RunContext {
  return {
    runId: 'run',
    bot: { model: 'fixture' } as RunContext['bot'],
    connection: { id: 'connection', revision: 1 } as RunContext['connection'],
    binding: { id: 'binding', generation: 1 } as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'hi',
    messages: [],
    instructions: 'system',
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
async function turn(url: string, context: RunContext, cache: ChatReplayCompatibility) {
  let step = 0;
  return requestManagedTurn(
    createClient(url),
    context,
    'chat-completions',
    new ManagedRunState(context),
    {
      chatReplay: cache,
      nextStep: () => ++step,
      recordDuration: () => {},
      recovered: false,
      retryDelays: [],
    },
  );
}
