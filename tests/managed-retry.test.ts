import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient, providerError } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { isRecoverableStreamError } from '../src/providers/managed/request-errors.js';

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
const output = {
  type: 'message',
  id: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: '完成', annotations: [] }],
};
const call = {
  type: 'function_call',
  id: 'function',
  call_id: 'call',
  name: 'write',
  arguments: '{}',
  status: 'completed',
};
const completed = (items: unknown[] = [output]) => ({
  type: 'response.completed',
  response: {
    id: 'response',
    status: 'completed',
    output: items,
    usage: { input_tokens: 12, output_tokens: 3 },
  },
});
const overloaded = { type: 'error', code: 'server_is_overloaded', message: 'busy' };
const textDelta = {
  type: 'response.output_text.delta',
  output_index: 0,
  content_index: 0,
  item_id: 'message',
  delta: '开始',
};

describe('managed request recovery', () => {
  it('recovers an overloaded stream with paired monotonic attempts and excludes backoff from request duration', async () => {
    const server = await fixture((index) => ({
      events: index === 0 ? [overloaded] : [completed()],
    }));
    const events: ProviderEvent[] = [];
    const started = Date.now();
    const result = await runManaged(
      createClient(server.url),
      context(events),
      'responses',
      [80, 1],
    );
    const elapsed = Date.now() - started;
    const status = events
      .filter(
        (event) =>
          event.type === 'status' &&
          event.data.phase !== 'performance' &&
          !String(event.data.phase).startsWith('model-cache-'),
      )
      .map((event) => event.data);
    expect(status.map((event) => event.phase)).toEqual([
      'model-request',
      'model-error',
      'model-retry',
      'model-request',
      'model-response',
    ]);
    expect(
      status.filter((event) => event.phase === 'model-request').map((event) => event.step),
    ).toEqual([1, 2]);
    expect(status.map((event) => event.requestId)).toEqual([
      'run:1',
      'run:1',
      'run:1',
      'run:2',
      'run:2',
    ]);
    expect(status[1]).toMatchObject({ step: 1, code: 'server_is_overloaded' });
    expect(status[2]).toMatchObject({ step: 1, attempt: 1, delayMs: 80 });
    expect(status[1]).not.toHaveProperty('usage');
    expect(status[4].usage).toEqual({ inputTokens: 12, outputTokens: 3, source: 'reported' });
    expect(result.modelDurationMs).toBe(
      Number(status[1].durationMs) + Number(status[4].durationMs),
    );
    expect(elapsed - result.modelDurationMs!).toBeGreaterThanOrEqual(70);
    expect(result.text).toBe('完成');
    expect(server.requests).toHaveLength(2);
  });

  it('excludes context compaction and checkpoint preparation from request timing and counting', async () => {
    const server = await fixture(() => ({ events: [completed()] }));
    const events: ProviderEvent[] = [];
    const clock = Date.now.bind(Date);
    let preparationMs = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock() + preparationMs);
    try {
      const result = await runManaged(
        createClient(server.url),
        {
          ...context(events),
          compactContext: async () => {
            preparationMs += 60_000;
            expect(events.some((event) => event.data.phase === 'model-request')).toBe(false);
            return undefined;
          },
        },
        'responses',
      );
      expect(server.requests).toHaveLength(1);
      expect(result.modelDurationMs).toBeLessThan(60_000);
      const response = events.find((event) => event.data.phase === 'model-response');
      expect(response?.data.durationMs).toBe(result.modelDurationMs);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([429, 502, 503, 504])(
    'recovers HTTP %s without rerunning an already executed tool',
    async (status) => {
      const server = await fixture((index) =>
        index === 1
          ? { status, code: 'server_error' }
          : { events: [completed(index === 0 ? [call] : [output])] },
      );
      let writes = 0;
      const result = await runManaged(
        createClient(server.url),
        {
          ...context([]),
          executeTool: async () => {
            writes++;
            return { written: true };
          },
        },
        'responses',
        [1, 1],
      );
      expect(result.text).toBe('完成');
      expect(writes).toBe(1);
      expect(server.requests).toHaveLength(3);
      expect(server.requests[2]).toEqual(server.requests[1]);
      expect(server.requests[2].input).toContainEqual({
        type: 'function_call_output',
        call_id: 'call',
        output: '{"written":true}',
      });
    },
  );

  it('recovers a truncated reply after a successful write and keeps only the completed text prefix', async () => {
    const server = await fixture((index) => ({
      events:
        index === 0
          ? [
              completed([
                {
                  ...output,
                  content: [{ type: 'output_text', text: '已保存。', annotations: [] }],
                },
                call,
              ]),
            ]
          : index === 1
            ? [textDelta]
            : [completed()],
    }));
    const events: ProviderEvent[] = [];
    let writes = 0;
    const result = await runManaged(
      createClient(server.url),
      {
        ...context(events),
        executeTool: async () => {
          writes++;
          return { written: true };
        },
      },
      'responses',
      [1],
    );
    expect(writes).toBe(1);
    expect(result.text).toBe('已保存。完成');
    expect(events).toContainEqual({ type: 'text', data: { replace: '已保存。' } });
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]).toEqual(server.requests[1]);
  });

  it.each(['ECONNRESET', 'ERR_CONNECTION_CLOSED', 'ETIMEDOUT', 'UND_ERR_SOCKET'])(
    'recognizes nested transport code %s',
    (code) => {
      expect(
        isRecoverableStreamError(
          new Error('transport', { cause: Object.assign(new Error('connection'), { code }) }),
        ),
      ).toBe(true);
    },
  );

  it.each([
    new TypeError('Unexpected application value'),
    Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('TLS'), { code: 'ERR_CERT_AUTHORITY_INVALID' }),
    new DOMException('cancelled', 'AbortError'),
  ])(
    'does not classify application, certificate or cancellation errors as recoverable: %s',
    (error) => {
      expect(isRecoverableStreamError(error)).toBe(false);
    },
  );

  it('recovers an explicit failed response before any output', async () => {
    const failed = {
      type: 'response.failed',
      response: {
        id: 'response',
        status: 'failed',
        output: [],
        error: { code: 'server_is_overloaded', message: 'busy' },
      },
    };
    const server = await fixture((index) => ({ events: [index === 0 ? failed : completed()] }));
    const result = await runManaged(createClient(server.url), context([]), 'responses', [1, 1]);
    expect(result.text).toBe('完成');
    expect(server.requests).toHaveLength(2);
  });

  it('recovers Chat Completions request rejection before any output', async () => {
    const server = await fixture((index) =>
      index === 0
        ? { status: 503, code: 'server_error' }
        : {
            events: [
              {
                id: 'chat',
                object: 'chat.completion.chunk',
                model: 'fixture',
                choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }],
              },
            ],
          },
    );
    const result = await runManaged(
      createClient(server.url),
      context([]),
      'chat-completions',
      [1, 1],
    );
    expect(result.text).toBe('完成');
    expect(server.requests).toHaveLength(2);
  });

  it('allows only five retries and keeps friendly safe error details', async () => {
    const server = await fixture(() => ({ events: [overloaded] }));
    let failure: unknown;
    const events: ProviderEvent[] = [];
    try {
      await runManaged(createClient(server.url), context(events), 'responses', [1, 1, 1, 1, 1, 1]);
    } catch (error) {
      failure = error;
    }
    expect(server.requests).toHaveLength(6);
    expect(
      events
        .filter((event) => event.data.phase === 'model-retry')
        .map((event) => event.data.attempt),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      events
        .filter((event) => event.data.phase === 'model-retry')
        .every(
          (event) =>
            event.data.maxAttempts === 5 &&
            !Number.isNaN(Date.parse(String(event.data.nextAttemptAt))),
        ),
    ).toBe(true);
    expect(providerError(failure).message).toBe('模型服务繁忙，请稍后重试（server_is_overloaded）');
    expect(
      providerError(Object.assign(new Error('busy'), { status: 503, code: 'server_error' }))
        .message,
    ).toBe('模型服务繁忙，请稍后重试（HTTP 503，server_error）');
    expect(providerError(Object.assign(new Error('bad'), { code: '<unsafe>' })).message).toBe(
      'bad',
    );
  });

  it('interrupts the retry delay immediately on cancellation', async () => {
    const server = await fixture(() => ({ status: 503, code: 'server_error' }));
    const controller = new AbortController();
    const run = {
      ...context([]),
      signal: controller.signal,
      emit: (event: ProviderEvent) => {
        if (event.data.phase === 'model-retry')
          setTimeout(() => controller.abort(new Error('cancelled')), 5);
      },
    };
    const started = Date.now();
    await expect(
      runManaged(createClient(server.url), run, 'responses', [10_000, 10_000]),
    ).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    [400, 'invalid_parameter'],
    [401, 'invalid_api_key'],
    [403, 'permission_denied'],
  ])('does not retry HTTP %s / %s', async (status, code) => {
    const server = await fixture(() => ({ status: status as number, code: code as string }));
    await expect(
      runManaged(createClient(server.url), context([]), 'responses', [1, 1]),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    { prefix: [textDelta] },
    {
      prefix: [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...call, status: 'in_progress' },
        },
      ],
    },
  ])(
    'replaces interrupted Responses output without executing partial tools',
    async ({ prefix }) => {
      const server = await fixture((index) => ({ events: index === 0 ? prefix : [completed()] }));
      let writes = 0;
      const events: ProviderEvent[] = [];
      const result = await runManaged(
        createClient(server.url),
        {
          ...context(events),
          executeTool: async () => {
            writes++;
          },
        },
        'responses',
        [1, 1],
      );
      expect(result.text).toBe('完成');
      expect(events).toContainEqual({ type: 'text', data: { replace: '' } });
      expect(server.requests).toHaveLength(2);
      expect(writes).toBe(0);
    },
  );

  it.each([
    { content: '开始' },
    {
      tool_calls: [
        { index: 0, id: 'call', type: 'function', function: { name: 'write', arguments: '{' } },
      ],
    },
  ])('replaces interrupted Chat output without executing partial tools', async (delta) => {
    const server = await fixture((index) => ({
      events: [
        {
          id: 'chat',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: index === 0 ? delta : { content: '完成' },
              finish_reason: index === 0 ? null : 'stop',
            },
          ],
        },
      ],
    }));
    let writes = 0;
    const result = await runManaged(
      createClient(server.url),
      {
        ...context([]),
        executeTool: async () => {
          writes++;
        },
      },
      'chat-completions',
      [1, 1],
    );
    expect(result.text).toBe('完成');
    expect(writes).toBe(0);
    expect(server.requests).toHaveLength(2);
  });
});

async function fixture(
  handler: (index: number) => { status?: number; code?: string; events?: unknown[] },
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const index = requests.push(JSON.parse(body)) - 1;
    const result = handler(index);
    if (result.status) {
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: result.code, message: 'rejected' } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(result.events!.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server failed');
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}
function context(events: ProviderEvent[]): RunContext {
  return {
    runId: 'run',
    bot: { model: 'fixture' } as RunContext['bot'],
    connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'hi',
    messages: [],
    instructions: 'Help',
    tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' } }],
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
