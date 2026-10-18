import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelImage, RunContext } from '../src/domain/provider.js';
import type { Message } from '../src/domain/types.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';
import { chatInput, responsesInput } from '../src/providers/managed/messages.js';
import { antigravityImagePrompt, qoderImageContent, toolResultMessage } from '../src/providers/images.js';
import { qoderCatalog } from '../src/providers/native/qoder.js';
import { decodeModelCatalog, supplementChatGptCatalog } from '../src/providers/managed/catalog.js';
import { estimateTokens, modelMessageHistory } from '../src/runtime/model-history.js';

const servers: Server[] = [];
const image: ModelImage = { artifactId: 'image-1', mimeType: 'image/png', width: 8, height: 8 };
const data = 'aW1hZ2U=';
const imageUrl = `data:image/png;base64,${data}`;
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

describe('model image protocol', () => {
  for (const protocol of ['responses', 'chat-completions'] as const) {
    it(`sends attachment and tool images through the actual ${protocol} SDK request`, async () => {
      const requests: any[] = [];
      const server = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (protocol === 'responses') {
          const output = requests.length === 1 ? [{ type: 'function_call', id: 'fc', call_id: 'read', name: 'read_artifact', arguments: '{}', status: 'completed' }]
            : [{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Seen', annotations: [] }] }];
          res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'response', status: 'completed', output } })}\n\n`);
        } else {
          const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_artifact', arguments: '{}' } }] } : { content: 'Seen' };
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
        }
      });
      const context = await testContext(server, protocol);
      context.images = [image];
      const page = { ...image, artifactId: 'image-2' };
      const pageUrl = 'data:image/png;base64,cGFnZTI=';
      context.executeTool = async () => ({ content: [{ type: 'text', text: 'Rendered page' },
        { type: 'image', image }, { type: 'image', image: page }] });
      context.resolveImage = async input => ({ mimeType: image.mimeType, data: input.artifactId === page.artifactId ? 'cGFnZTI=' : data });
      const result = await new CustomApiAdapter().run(context);
      expect(result.text).toBe('Seen'); expect(requests).toHaveLength(2);
      if (protocol === 'responses') {
        expect(requests[0].input.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'input_image', image_url: imageUrl, detail: 'auto' }] });
        expect(requests[1].input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'read', output: [
          { type: 'input_text', text: 'Rendered page' }, { type: 'input_image', image_url: imageUrl, detail: 'auto' },
          { type: 'input_image', image_url: pageUrl, detail: 'auto' },
        ] });
      } else {
        expect(requests[0].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] });
        expect(requests[1].messages.at(-2)).toEqual({ role: 'tool', tool_call_id: 'read', content: 'Rendered page' });
        expect(requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: [
          { type: 'text', text: '以下图片来自前述工具返回。' }, { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'image_url', image_url: { url: pageUrl } },
        ] });
      }
      expect(JSON.stringify(result.messages)).not.toContain(data);
      expect(result.messages?.find(message => message.role === 'tool')?.images).toEqual([image, page]);
    });
  }

  it('places Chat tool images after all outputs in a parallel tool batch', () => {
    const messages = [
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }, { id: 'b', name: 'read', arguments: '{}' }] },
      { role: 'tool' as const, content: 'image', callId: 'a', images: [image] },
      { role: 'tool' as const, content: 'text', callId: 'b' },
    ];
    expect(chatInput(messages, '', new Map([[image.artifactId, imageUrl]])).map(message => message.role))
      .toEqual(['system', 'assistant', 'tool', 'tool', 'user']);
  });

  it('keeps Qoder SDK image blocks native and agy prompts textual', async () => {
    const context = await testContext(createServer(), 'responses'); context.images = [image];
    expect(await qoderImageContent(context)).toEqual([{ type: 'text', text: '' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
    expect(antigravityImagePrompt('Look', [image])).toContain('read_artifact（artifactId）');
    expect(antigravityImagePrompt('Look', [image])).toContain(image.artifactId);
    expect(antigravityImagePrompt('Look', [image])).not.toContain(data);
    expect(antigravityImagePrompt('Text', [])).toBe('Text');
  });

  it('retains references through history and estimates without encoded pixel data', () => {
    const history = modelMessageHistory([{ id: 'm', sequence: 1, status: 'committed', authorType: 'user', content: '', artifactIds: [image.artifactId] } as Message],
      'bot', id => id === image.artifactId ? image : undefined);
    expect(history[0].message.images).toEqual([image]);
    expect(toolResultMessage('read', { content: [{ type: 'image', image }] }).images).toEqual([image]);
    expect(estimateTokens({ image_url: `data:image/png;base64,${'a'.repeat(100_000)}` })).toBeLessThan(20);
    expect(() => responsesInput([history[0].message])).toThrow('尚未解析');
  });

  it('respects explicit model capability and leaves unknown capability usable', async () => {
    const context = await testContext(createServer(), 'responses'); context.images = [image];
    context.connection.models = [{ id: 'model', name: 'Text', imageInput: 'unsupported' }];
    await expect(qoderImageContent(context)).rejects.toThrow('不支持图片');
    expect(qoderCatalog([{ value: 'vision', isVl: true }, { value: 'text', isVl: false }] as any).map(model => model.imageInput))
      .toEqual(['supported', 'unsupported']);
    const models = decodeModelCatalog({ data: [{ id: 'text', input_modalities: ['text'] }, { id: 'vision', inputModalities: ['text', 'image'] }, { id: 'unknown' }] }, false)!;
    expect(models.map(model => model.imageInput)).toEqual(['unsupported', 'supported', undefined]);
    const supplemented = await supplementChatGptCatalog(models, async () => [{ id: 'text', name: 'Text', imageInput: 'supported' }, { id: 'unknown', name: 'Unknown', imageInput: 'supported' }]);
    expect(supplemented.map(model => model.imageInput)).toEqual(['unsupported', 'supported', 'supported']);
  });
});

async function testContext(server: Server, protocol: RunContext['connection']['protocol']): Promise<RunContext> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test server');
  return { runId: 'run', bot: { model: 'model' } as RunContext['bot'],
    connection: { id: 'connection', name: 'Test', concurrency: 1, status: 'ready', revision: 1, createdAt: '',
      provider: 'custom', protocol, authMode: 'none', models: [], baseUrl: `http://127.0.0.1:${address.port}/v1` },
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: '', messages: [], instructions: 'Help',
    tools: [{ name: 'read_artifact', description: 'Read', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
    executeTool: async () => ({ content: [{ type: 'text', text: 'Rendered page' }, { type: 'image', image }] }),
    resolveImage: async () => ({ mimeType: image.mimeType, data }),
    getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {} };
}
