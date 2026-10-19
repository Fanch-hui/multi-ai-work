import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage, RunContext, RunUserInput } from '../src/domain/provider.js';
import type { Protocol } from '../src/domain/types.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

class Inbox implements RunUserInput {
  pending: ModelMessage[] = [];
  replies: (string | undefined)[] = [];
  acknowledged: string[] = [];
  listeners = new Set<() => void>();
  take() {
    return this.pending.splice(0);
  }
  acknowledge(messageIds: string[]) {
    this.acknowledged.push(...messageIds);
  }
  hasPending() {
    return this.pending.length > 0;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  beginReply(output?: string) {
    this.replies.push(output);
  }
  send() {
    this.pending.push({
      role: 'user',
      content: 'Use the updated budget',
      sourceMessageId: 'change',
      sourceSequence: 3,
    });
    for (const listener of this.listeners) listener();
  }
}

const send = (res: ServerResponse, value: unknown) =>
  res.write(`data: ${JSON.stringify(value)}\n\n`);
function complete(res: ServerResponse, protocol: Protocol, text: string, tool = false) {
  if (protocol === 'responses')
    send(res, {
      type: 'response.completed',
      response: {
        id: 'response',
        status: 'completed',
        output: tool
          ? [
              {
                type: 'function_call',
                id: 'fc',
                call_id: 'write-once',
                name: 'write',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'answer',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
              },
            ],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: {} },
      },
    });
  else {
    send(res, {
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'write-once',
                    type: 'function',
                    function: { name: 'write', arguments: '{}' },
                  },
                ],
              }
            : { content: text },
          finish_reason: tool ? 'tool_calls' : 'stop',
        },
      ],
    });
    send(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    res.write('data: [DONE]\n\n');
  }
}
function started(res: ServerResponse, protocol: Protocol) {
  if (protocol === 'responses')
    send(res, {
      type: 'response.created',
      response: { id: 'pending', status: 'in_progress', output: [] },
    });
  else send(res, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
}

async function fixture(
  protocol: Protocol,
  respond: (res: ServerResponse, index: number, inbox: Inbox) => void,
) {
  const requests: Record<string, any>[] = [],
    inbox = new Inbox();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    respond(res, requests.length, inbox);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test server');
  const context: RunContext = {
    runId: 'run',
    bot: { model: 'model' } as RunContext['bot'],
    connection: {
      provider: 'custom',
      protocol,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      authMode: 'none',
    } as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'Make the document',
    messages: [],
    instructions: '',
    tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }],
    userInput: inbox,
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: () => {},
    executeTool: async () => ({ saved: true }),
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
  return { context, requests, inbox };
}

describe('managed streaming request boundaries', () => {
  it('completes Responses on its terminal event while the HTTP connection remains open', async () => {
    const { context, requests, inbox } = await fixture('responses', (res) =>
      complete(res, 'responses', 'Done'),
    );
    const result = await new CustomApiAdapter().run(context);
    expect(result.text).toBe('Done');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(requests).toHaveLength(1);
    expect(inbox.listeners.size).toBe(0);
  });

  it.each(['responses', 'chat-completions'] as const)(
    'takes a supplement during an output-free %s request without replaying a write',
    async (protocol) => {
      let cancelled!: Promise<void>;
      const { context, requests, inbox } = await fixture(protocol, (res, index, pending) => {
        if (index === 1) {
          complete(res, protocol, '', true);
          res.end();
          return;
        }
        if (index === 2) {
          cancelled = new Promise((resolve) => res.once('close', resolve));
          started(res, protocol);
          setTimeout(() => pending.send(), 20);
          return;
        }
        expect(pending.acknowledged).toEqual([]);
        complete(res, protocol, 'Updated document');
        res.end();
      });
      let writes = 0;
      context.executeTool = async () => {
        writes++;
        return { saved: true };
      };
      const phases: unknown[] = [];
      context.emit = (event) => {
        if (event.type === 'status') phases.push(event.data.phase);
      };
      const result = await new CustomApiAdapter().run(context);
      await cancelled;
      expect(writes).toBe(1);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2])).toContain('Use the updated budget');
      expect(JSON.stringify(requests[2])).toContain('write-once');
      expect(result.messages?.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
      ]);
      expect(result.text).toBe('Updated document');
      expect(context.signal.aborted).toBe(false);
      expect(result.usage?.source).toBe('unknown');
      expect(result.usage?.inputTokens).toBeUndefined();
      expect(phases).toContain('model-input');
      expect(phases).not.toContain('model-error');
      expect(inbox.acknowledged).toEqual(['change']);
      expect(inbox.listeners.size).toBe(0);
    },
  );

  it('acknowledges a successful request before its tool fails and excludes archived source IDs', async () => {
    const { context, inbox } = await fixture('responses', (res) => {
      complete(res, 'responses', '', true);
      res.end();
    });
    context.messages = [{ role: 'user', content: 'Earlier input', sourceMessageId: 'archive' }];
    inbox.send();
    context.executeTool = async () => {
      expect(inbox.acknowledged).toEqual(['change']);
      throw new Error('Tool failed after receiving the change');
    };
    await expect(new CustomApiAdapter().run(context)).rejects.toThrow('Tool failed');
    expect(inbox.acknowledged).toEqual(['change']);
  });

  it('takes a supplement during recovery backoff without acknowledging the interrupted request', async () => {
    const { context, requests, inbox } = await fixture('responses', (res, index, pending) => {
      expect(pending.acknowledged).toEqual([]);
      if (index === 1)
        send(res, {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'partial',
          delta: '旧草稿',
        });
      else complete(res, 'responses', 'Updated');
      res.end();
    });
    const textEvents: unknown[] = [];
    context.emit = (event) => {
      if (event.type === 'text') textEvents.push(event.data);
      if (event.data.phase === 'model-retry') inbox.send();
    };
    const started = Date.now();
    const result = await runManaged(
      createClient(context.connection.baseUrl!),
      context,
      'responses',
      [10_000],
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.text).toBe('Updated');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('Use the updated budget');
    expect(textEvents).toContainEqual({ replace: '' });
    expect(inbox.replies).toEqual(['']);
    expect(inbox.acknowledged).toEqual(['change']);
    expect(inbox.listeners.size).toBe(0);
  });

  it('keeps an active reasoning response until its complete boundary before taking a supplement', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'reason',
      summary: [],
      encrypted_content: 'opaque-reasoning',
    };
    const { context, requests, inbox } = await fixture('responses', (res, index, pending) => {
      if (index > 1) {
        complete(res, 'responses', 'Updated');
        res.end();
        return;
      }
      send(res, { type: 'response.output_item.added', output_index: 0, item: reasoning });
      setTimeout(() => {
        pending.send();
        send(res, {
          type: 'response.completed',
          response: { id: 'first', status: 'completed', output: [reasoning] },
        });
      }, 20);
    });
    const result = await new CustomApiAdapter().run(context);
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toContainEqual(reasoning);
    expect(requests[1].input.at(-1).content).toBe('Use the updated budget');
    expect(result.text).toBe('Updated');
    expect(inbox.listeners.size).toBe(0);
  });

  it.each(['responses', 'chat-completions'] as const)(
    'stops a %s body with no new events for five minutes',
    async (protocol) => {
      const { context, requests, inbox } = await fixture(protocol, (res) => started(res, protocol));
      let observed!: () => void;
      const activity = new Promise<void>((resolve) => {
        observed = resolve;
      });
      context.emit = (event) => {
        if (event.type === 'status' && event.data.phase === 'model-activity') observed();
      };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const run = runManaged(createClient(context.connection.baseUrl!), context, protocol, []);
      const failure = expect(run).rejects.toThrow('连续 5 分钟没有活动');
      await activity;
      await vi.advanceTimersByTimeAsync(300_000);
      await failure;
      expect(requests).toHaveLength(1);
      expect(context.signal.aborted).toBe(false);
      expect(inbox.listeners.size).toBe(0);
    },
  );
});
