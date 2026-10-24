import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import { ChatGptAdapter } from '../src/providers/managed/index.js';
import { InterruptedModelStreamError } from '../src/providers/managed/request-errors.js';
import {
  configureProviderFetch,
  configureProviderWebSocket,
  type ProviderSocket,
} from '../src/providers/network.js';

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

describe('ChatGPT login reasoning compatibility', () => {
  it('uses the selected request effort for an independent background request', async () => {
    const requests: Record<string, unknown>[] = [];
    configureProviderFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return completed(requests.length);
    });
    const adapter = new ChatGptAdapter();
    try {
      const result = await adapter.run(context());
      expect(result.text).toBe('done');
      expect(requests).toHaveLength(1);
      expect(requests[0].reasoning).toEqual({ effort: 'low' });
      expect(requests[0].input).toEqual([{ role: 'user', content: 'start' }]);
    } finally {
      await adapter.close();
    }
  });

  it('applies changed effort at a tool boundary and preserves the archived configuration history', async () => {
    const requests: Record<string, unknown>[] = [];
    const sessions: (string | null)[] = [];
    configureProviderFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      sessions.push(new Headers(init?.headers).get('session-id'));
      return completed(
        requests.length,
        requests.length === 1
          ? [
              {
                type: 'function_call',
                call_id: 'advance-1',
                name: 'advance',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : undefined,
      );
    });
    const update: ModelMessage = {
      role: 'assistant',
      content: '',
      reasoningUpdate: { baseline: 'medium', effort: 'medium' },
    };
    const run = context();
    run.messages = [
      { role: 'user', content: 'earlier request' },
      update,
      { role: 'assistant', content: 'earlier answer' },
    ];
    let effort = 'low';
    run.getReasoningEffort = () => effort;
    run.tools = [{ name: 'advance', description: '', inputSchema: { type: 'object' } }];
    let executions = 0;
    run.executeTool = async () => {
      executions++;
      effort = 'high';
      return 'advanced';
    };
    const adapter = new ChatGptAdapter();
    try {
      const result = await adapter.run(run);
      expect(result.text).toBe('done');
      expect(executions).toBe(1);
      expect(sessions).toEqual(['binding', 'binding']);
      expect(requests.map((body) => body.reasoning)).toEqual([
        { effort: 'low' },
        { effort: 'high' },
      ]);
      for (const body of requests)
        expect(
          (body.input as { type?: string }[]).some((item) => item.type === 'configuration_update'),
        ).toBe(false);
      expect(requests[1].input).toContainEqual({
        type: 'function_call_output',
        call_id: 'advance-1',
        output: 'advanced',
      });
      expect(result.messages?.filter((message) => message.reasoningUpdate)).toEqual([update]);
      expect(result.contextMessages?.filter((message) => message.reasoningUpdate)).toEqual([
        update,
      ]);
    } finally {
      await adapter.close();
    }
  });
});

function context(): RunContext {
  return {
    runId: 'run',
    bot: { id: 'bot', model: 'gpt-6-luna', reasoning: 'low' } as RunContext['bot'],
    connection: {
      id: 'connection',
      revision: 1,
      provider: 'chatgpt',
      secretRef: 'fixture',
      models: [{ id: 'gpt-6-luna', supportsReasoningEffortUpdates: true }],
    } as RunContext['connection'],
    binding: { id: 'binding', generation: 1 } as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'start',
    messages: [],
    instructions: 'Help',
    tools: [],
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: () => {},
    executeTool: async () => 'done',
    getSecret: async () =>
      JSON.stringify({
        client_id: 'fixture-client',
        subject: 'fixture-subject',
        issuer: 'https://auth.openai.com',
        ext_agent_host_id: 'fixture-host',
        access_token: 'fixture-access',
        id_token: 'fixture-id',
        token_type: 'Bearer',
        scopes: ['chatgpt.tokens.use.direct'],
        expires_at: Date.now() + 3600000,
      }),
    saveSecret: async () => {},
    persistBinding: () => {},
  };
}

function completed(
  index: number,
  output: unknown[] = [
    {
      type: 'message',
      id: `message-${index}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    },
  ],
): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { id: `response-${index}`, status: 'completed', output },
    })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
