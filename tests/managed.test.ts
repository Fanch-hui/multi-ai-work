import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions';
import { CustomApiAdapter } from '../src/providers/managed/index.js';
import { ResponsesAccumulator } from '../src/providers/managed/responses.js';
import { ChatAccumulator } from '../src/providers/managed/chat.js';
import { responsesInput, parseToolArguments } from '../src/providers/managed/messages.js';
import { createClient, endpoint } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { OAuthManager } from '../src/security/oauth.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const responseEvent = (output: unknown[], text = '', type = 'response.completed') => ({ type,
  response: { id: 'response1', status: 'completed', output, usage: { input_tokens: 12, output_tokens: 7 } },
  delta: text,
}) as unknown as ResponseStreamEvent;
const message = (text: string) => ({ id: 'msg', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });

describe('managed streaming and tool state', () => {
  it.each(['responses', 'chat-completions'] as const)('completes fifteen tool rounds through %s without cutting off the task', async protocol => {
    let requests = 0, writes = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (protocol === 'responses') {
        const output = requests <= 15 ? [{ type: 'function_call', id: `fc${requests}`, call_id: `call${requests}`,
          name: 'write', arguments: '{}', status: 'completed' }] : [message('Done')];
        res.end(`data: ${JSON.stringify(responseEvent(output))}\n\n`);
      } else {
        const delta = requests <= 15 ? { tool_calls: [{ index: 0, id: `call${requests}`, type: 'function',
          function: { name: 'write', arguments: '{}' } }] } : { content: 'Done' };
        const chunk = { id: `chat${requests}`, object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0,
          delta, finish_reason: requests <= 15 ? 'tool_calls' : 'stop' }] };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      }
    });
    const context = runContext(await listen(server), async () => { writes++; return { saved: true }; });
    context.connection.protocol = protocol;
    const result = await new CustomApiAdapter().run(context);
    expect(result.text).toBe('Done'); expect(writes).toBe(15); expect(requests).toBe(16);
    expect(result.messages!.filter(item => item.role === 'tool')).toHaveLength(15);
  });

  it('honors user cancellation after fourteen tool rounds', async () => {
    let requests = 0, writes = 0;
    const cancel = new AbortController();
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(responseEvent([{ type: 'function_call', id: `fc${requests}`, call_id: `call${requests}`,
        name: 'write', arguments: '{}', status: 'completed' }]))}\n\n`);
    });
    const context = runContext(await listen(server), async () => {
      if (++writes === 14) cancel.abort(new Error('用户停止'));
      return { saved: true };
    });
    context.signal = cancel.signal;
    await expect(new CustomApiAdapter().run(context)).rejects.toThrow('用户停止');
    expect(writes).toBe(14); expect(requests).toBe(14);
  });

  it('ends on user input with paired tool returns and does not execute later calls', async () => {
    let requests = 0, writes = 0, waiting = false;
    const server = createServer(async (_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const output = ['ask_user', 'write'].map((name, index) => ({ type: 'function_call', id: `fc${index}`, call_id: `call${index}`, name, arguments: '{}', status: 'completed' }));
      res.end(`data: ${JSON.stringify(responseEvent(output))}\n\n`);
    });
    const url = await listen(server);
    const context = runContext(url, async name => { if (name === 'ask_user') { waiting = true; return { waitingForInput: true }; } writes++; return {}; });
    context.tools.push({ name: 'ask_user', description: 'question', inputSchema: { type: 'object' } });
    context.isWaitingForInput = () => waiting;
    const result = await new CustomApiAdapter().run(context);
    expect(result.outcome).toBe('waiting_input'); expect(requests).toBe(1); expect(writes).toBe(0);
    expect(result.messages!.filter(item => item.role === 'tool').map(item => item.callId)).toEqual(['call0', 'call1']);
  });
  it('retains opaque Responses items for continuation and requires the terminal event', () => {
    const accumulator = new ResponsesAccumulator(() => {});
    accumulator.accept({ type: 'response.output_text.delta', delta: 'Hello' } as ResponseStreamEvent);
    expect(() => accumulator.finish()).toThrow('response.completed');
    const opaque = { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] };
    accumulator.accept(responseEvent([opaque, message('Hello')]));
    const turn = accumulator.finish();
    expect(turn.message.content).toBe('Hello');
    expect(responsesInput([turn.message])).toEqual([opaque, message('Hello')]);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 7, source: 'reported' });
  });
  it('keeps Chat Completions question tool pairs for continuation after the answer', async () => {
    let requests = 0, waiting = false;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = { id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0,
        delta: { tool_calls: [{ index: 0, id: 'question', type: 'function', function: { name: 'ask_user', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    const context = runContext(await listen(server), async () => { waiting = true; return { waitingForInput: true }; });
    context.connection.protocol = 'chat-completions'; context.isWaitingForInput = () => waiting;
    context.tools.push({ name: 'ask_user', description: 'question', inputSchema: { type: 'object' } });
    const result = await new CustomApiAdapter().run(context);
    const { chatInput } = await import('../src/providers/managed/messages.js');
    expect(result.outcome).toBe('waiting_input'); expect(requests).toBe(1);
    expect(chatInput(result.messages!, context.instructions)).toContainEqual({ role: 'tool', tool_call_id: 'question', content: '{"waitingForInput":true}' });
  });
  it('reassembles Chat Completions tool arguments before executing them', () => {
    const accumulator = new ChatAccumulator(() => {});
    accumulator.accept({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'write', arguments: '{"path":' } }] }, finish_reason: null }] } as ChatCompletionChunk);
    accumulator.accept({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"file.md"}' } }] }, finish_reason: 'tool_calls' }] } as ChatCompletionChunk);
    expect(parseToolArguments(accumulator.finish().message.toolCalls![0].arguments)).toEqual({ path: 'file.md' });
    expect(() => parseToolArguments('[]')).toThrow();
  });
  it('completes a real SDK stream, a tool round, and usage accounting through a local protocol server', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const output = requests.length === 1 ? [
        { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] },
        { type: 'function_call', id: 'fc', call_id: 'call1', name: 'write', arguments: '{"path":"file.md"}', status: 'completed' },
      ] : [message('Saved')];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(responseEvent(output))}\n\n`);
    });
    const url = await listen(server);
    let writes = 0;
    const context = runContext(url, async (_name, args) => { writes++; return { saved: args.path }; });
    const result = await new CustomApiAdapter().run(context);
    expect(writes).toBe(1);
    expect(result.text).toBe('Saved');
    expect(result.usage?.inputTokens).toBe(24);
    expect(requests[0]).toMatchObject({ store: false, stream: true });
    expect(requests[0]).not.toHaveProperty('previous_response_id');
    expect(requests[1].input).toContainEqual({ type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] });
    expect(requests[1].input).toContainEqual({ type: 'function_call_output', call_id: 'call1', output: '{"saved":"file.md"}' });
  });
  it('retries an interrupted stream five times without executing incomplete tool calls', async () => {
    let requests = 0, writes = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call1","name":"write","arguments":"{}"}}\n\n');
    });
    const url = await listen(server);
    await expect(runManaged(createClient(url), runContext(url, async () => { writes++; }), 'responses', [1, 1, 1, 1, 1]))
      .rejects.toThrow('response.completed');
    expect(requests).toBe(6); expect(writes).toBe(0);
  });
  it('excludes tool wait from model timing and keeps missing request usage unknown', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      const output = requests === 1 ? [{ type: 'function_call', id: 'fc', call_id: 'write', name: 'write', arguments: '{}', status: 'completed' }] : [message('Done')];
      const event = responseEvent(output) as any;
      if (requests === 1) delete event.response.usage;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(event)}\n\n`);
    });
    let toolDuration = 0;
    const context = runContext(await listen(server), async () => {
      const started = Date.now(); await new Promise(resolve => setTimeout(resolve, 200));
      toolDuration = Date.now() - started; return { saved: true };
    });
    const started = Date.now(), result = await new CustomApiAdapter().run(context);
    expect(result.modelDurationMs).toBeGreaterThanOrEqual(0);
    expect(Date.now() - started - result.modelDurationMs!).toBeGreaterThanOrEqual(toolDuration - 10);
    expect(result.usage).toMatchObject({ inputTokens: undefined, outputTokens: undefined, cachedInputTokens: undefined, source: 'unknown' });
  });
  it('refuses authenticated redirects', async () => {
    const server = createServer((_req, res) => { res.writeHead(307, { location: 'http://127.0.0.1:9/stolen' }); res.end(); });
    await expect(new CustomApiAdapter().run(runContext(await listen(server), async () => {}))).rejects.toThrow();
    expect(() => endpoint({ provider: 'custom', baseUrl: 'http://example.org/v1' } as RunContext['connection'])).toThrow('HTTPS');
  });
});

describe('independent ChatGPT sign-in', () => {
  it('uses dynamic registration, fresh PKCE, a stable host, and refuses invalid callback state', async () => {
    const secrets = new Map<string, string>(), metadata = new Map<string, unknown>();
    const manager = new OAuthManager({ get: async ref => secrets.get(ref), set: async (ref, value) => { secrets.set(ref, value); }, delete: async ref => { secrets.delete(ref); } },
      { get: key => metadata.get(key), set: (key, value) => { metadata.set(key, value); } });
    try {
      const first = new URL((await manager.start('connection1')).url);
      expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(first.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
      expect(first.searchParams.get('code_challenge_method')).toBe('S256');
      const bad = await fetch(`${first.searchParams.get('redirect_uri')}?state=wrong&code=example`);
      expect(bad.status).toBe(400); expect(secrets.size).toBe(0);
      const second = new URL((await manager.start('connection1')).url);
      expect(second.searchParams.get('ext_agent_host_id')).toBe(first.searchParams.get('ext_agent_host_id'));
      expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'));
      expect(second.searchParams.get('nonce')).not.toBe(first.searchParams.get('nonce'));
      const denied = await fetch(`${second.searchParams.get('redirect_uri')}?state=${second.searchParams.get('state')}&error=access_denied`);
      expect(denied.status).toBe(400); expect(manager.status('connection1').status).toBe('error');
      expect(secrets.size).toBe(0);
    } finally { manager.close(); }
  });
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  return `http://127.0.0.1:${address.port}/v1`;
}
function runContext(baseUrl: string, executeTool: RunContext['executeTool']): RunContext {
  return { runId: 'run', bot: { model: 'model' } as RunContext['bot'],
    connection: { provider: 'custom', protocol: 'responses', baseUrl, authMode: 'none' } as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: 'Save file', messages: [], instructions: 'Help',
    tools: [{ name: 'write', description: 'Write file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {}, executeTool,
    getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {} };
}
