import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ManagedProgress,
  ModelImage,
  ModelMessage,
  RunContext,
} from '../src/domain/provider.js';
import type { Protocol } from '../src/domain/types.js';
import { prepareImageInputBudget } from '../src/core/image-input-budget.js';
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
const image = (artifactId: string): ModelImage => ({ artifactId, mimeType: 'image/png' });
const call = (id: string, artifactId: string) => ({
  id,
  name: 'read_artifact',
  arguments: JSON.stringify({ artifactId }),
});
const providerCall = (id: string, artifactId: string) => ({
  type: 'function_call',
  id: `item-${id}`,
  call_id: id,
  name: 'read_artifact',
  arguments: JSON.stringify({ artifactId }),
  status: 'completed',
});
const opaque = {
  type: 'reasoning',
  id: 'reasoning-item',
  encrypted_content: 'opaque-preserved',
  summary: [],
};
const payloads = new Map([
  ['old-a', 'a'.repeat(1_600_000)],
  ['old-b', 'b'.repeat(1_150_000)],
  ['current', 'c'.repeat(600_000)],
]);
const url = (id: string) => `data:image/png;base64,${payloads.get(id)}`;

describe.each<Protocol>(['chat-completions', 'responses'])(
  'managed image working history: %s',
  (protocol) => {
    it('sends a reduced image projection while preserving original evidence and protocol continuation', async () => {
      const { context, requests } = await fixture(protocol);
      const original = structuredClone(context.messages);
      const saved: ManagedProgress[] = [];
      context.saveProgress = async (progress) => {
        saved.push(structuredClone(progress));
      };
      const result = await runManaged(
        createClient(context.connection.baseUrl!),
        context,
        protocol,
        [],
      );

      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]);
      expect(request).toContain(url('current'));
      expect(request).not.toContain(url('old-a'));
      expect(request).not.toContain(url('old-b'));
      expect(request).toContain('read_artifact');
      expect(request).toContain('old-a');
      expect(request).toContain('old-b');
      expect(request).toContain(
        protocol === 'responses' ? 'opaque-preserved' : 'preserved-reasoning',
      );
      expect(result.messages?.slice(0, original.length)).toEqual(original);
      expect(result.contextMessages?.[0]).toMatchObject({
        content: 'Original source',
        imageReferences: [image('old-a')],
        contextArtifactIds: ['old-a'],
      });
      expect(result.contextMessages?.[0].images).toBeUndefined();
      expect(result.contextMessages?.[2]).toMatchObject({
        role: 'tool',
        callId: 'old-call',
        content: 'Old preview',
        imageReferences: [image('old-b')],
      });
      expect(saved[0].phase).toBe('ready');
      expect(saved[0].compaction?.archived.slice(0, original.length)).toEqual(original);
      expect(result.text).toBe('Done');
    });

    it('resumes a saved projection without repeating completed tools and can read a retired image again', async () => {
      const { context, requests } = await fixture(protocol, true);
      const messages: ModelMessage[] = [
        ...context.messages,
        { role: 'user', content: 'Continue' },
        assistant(protocol, 'done-call', 'current'),
        {
          role: 'tool',
          callId: 'done-call',
          content: 'Already inspected',
          images: [image('current')],
        },
      ];
      context.progress = {
        messages,
        currentStart: context.messages.length,
        archiveStart: context.messages.length,
        text: '',
        pendingInputIds: [],
        turnId: 'previous-turn',
        attempt: 0,
        phase: 'tools',
      };
      let saved!: ManagedProgress;
      context.saveProgress = async (progress) => {
        saved = structuredClone(progress);
        if (progress.compaction) throw new Error('Exit after saving projection');
      };
      const executed: string[] = [];
      context.executeTool = async (name, args, id) => {
        expect(name).toBe('read_artifact');
        expect(args).toEqual({ artifactId: 'old-a' });
        executed.push(id);
        return { content: [{ type: 'image', image: image('old-a') }] };
      };
      await expect(
        runManaged(createClient(context.connection.baseUrl!), context, protocol, []),
      ).rejects.toThrow('Exit after saving projection');
      expect(requests).toHaveLength(0);
      expect(executed).toEqual([]);
      expect(saved.messages[0].images).toBeUndefined();
      expect(saved.messages[0].imageReferences).toEqual([image('old-a')]);

      context.progress = saved;
      context.runId = 'resumed';
      context.saveProgress = async (progress) => {
        saved = structuredClone(progress);
      };
      const result = await runManaged(
        createClient(context.connection.baseUrl!),
        context,
        protocol,
        [],
      );
      expect(executed).toEqual(['reopen']);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0])).not.toContain(url('old-a'));
      expect(JSON.stringify(requests[0])).toContain(url('current'));
      expect(JSON.stringify(requests[1])).toContain(url('old-a'));
      expect(requests.every((request) => !JSON.stringify(request).includes(url('old-b')))).toBe(
        true,
      );
      expect(
        result.messages
          ?.filter((message) => message.role === 'tool')
          .map((message) => message.callId),
      ).toEqual(['old-call', 'done-call', 'reopen']);
      expect(
        result.contextMessages?.filter((message) => message.role === 'tool').at(-1)?.images,
      ).toEqual([image('old-a')]);
      expect(result.messages?.[0].images).toEqual([image('old-a')]);
      expect(result.text).toBe('Done');
    });

    it('sends no request and executes no tool if saving the image projection fails', async () => {
      const { context, requests } = await fixture(protocol, true);
      let executed = 0;
      context.executeTool = async () => {
        executed++;
      };
      context.saveProgress = async (progress) => {
        expect(progress.compaction).toBeDefined();
        expect(progress.messages[0].imageReferences).toEqual([image('old-a')]);
        throw new Error('Storage unavailable');
      };
      await expect(
        runManaged(createClient(context.connection.baseUrl!), context, protocol, []),
      ).rejects.toThrow('Storage unavailable');
      expect(requests).toHaveLength(0);
      expect(executed).toBe(0);
    });
  },
);

function assistant(protocol: Protocol, id: string, artifactId: string): ModelMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [call(id, artifactId)],
    ...(protocol === 'responses'
      ? { providerItems: [opaque, providerCall(id, artifactId)] }
      : {
          chatReplay: {
            version: 1,
            bindingId: 'binding',
            generation: 1,
            reasoningField: 'reasoning_content',
            reasoningText: 'preserved-reasoning',
          },
        }),
  };
}

function events(protocol: Protocol, reopen: boolean): unknown[] {
  if (protocol === 'chat-completions')
    return [
      {
        id: 'completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'model',
        choices: [
          {
            index: 0,
            delta: reopen
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'reopen',
                      type: 'function',
                      function: {
                        name: 'read_artifact',
                        arguments: JSON.stringify({ artifactId: 'old-a' }),
                      },
                    },
                  ],
                }
              : { role: 'assistant', content: 'Done' },
            finish_reason: reopen ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ];
  return [
    {
      type: 'response.completed',
      response: {
        id: 'response',
        status: 'completed',
        output: reopen
          ? [providerCall('reopen', 'old-a')]
          : [
              {
                type: 'message',
                id: 'answer',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Done', annotations: [] }],
              },
            ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
}

async function fixture(protocol: Protocol, reopen = false) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const index = requests.push(JSON.parse(body)) - 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      events(protocol, reopen && index === 0)
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server');
  const context: RunContext = {
    runId: 'run',
    bot: { model: 'model' } as RunContext['bot'],
    connection: { baseUrl: `http://127.0.0.1:${address.port}/v1` } as RunContext['connection'],
    binding: { id: 'binding', generation: 1 } as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'Check the current page',
    images: [image('current')],
    messages: [
      { role: 'user', content: 'Original source', images: [image('old-a')] },
      assistant(protocol, 'old-call', 'old-b'),
      { role: 'tool', callId: 'old-call', content: 'Old preview', images: [image('old-b')] },
      { role: 'assistant', content: 'Old review complete' },
    ],
    instructions: '',
    tools: [
      {
        name: 'read_artifact',
        description: 'Read a saved artifact',
        inputSchema: { type: 'object' },
      },
    ],
    resolveImage: async (value) => ({
      mimeType: value.mimeType,
      data: payloads.get(value.artifactId)!,
    }),
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: () => {},
    executeTool: async () => {
      throw new Error('Unexpected tool execution');
    },
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
  context.prepareImageInputs = prepareImageInputBudget(context);
  return { context, requests };
}
