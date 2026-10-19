import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Protocol } from '../src/domain/types.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server =>
  new Promise<void>(resolve => server.close(() => resolve())))); });
const followup = (): ModelMessage => ({ role: 'user', content: 'Use the revised requirements',
  sourceMessageId: 'supplement', sourceSequence: 8,
  images: [{ artifactId: 'image', mimeType: 'image/png' }] });

async function fixture(protocol: Protocol, respond: (index: number) => { text?: string; tools?: string[]; overflow?: boolean }) {
  const requests: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const turn = respond(requests.length);
    if (turn.overflow) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'rejected' } })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const calls = (turn.tools ?? []).map((name, index) => ({ id: `call-${requests.length}-${index}`, name, arguments: '{}' }));
    if (protocol === 'responses') {
      const output = [
        ...(turn.text ? [{ type: 'message', id: `msg-${requests.length}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: turn.text, annotations: [] }] }] : []),
        ...calls.map(call => ({ type: 'function_call', id: `fc-${call.id}`, call_id: call.id,
          name: call.name, arguments: call.arguments, status: 'completed' })),
      ];
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'response', status: 'completed', output } })}\n\n`);
    } else {
      const delta = { content: turn.text ?? '', ...(calls.length ? { tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
      })) } : {}) };
      res.end(`data: ${JSON.stringify({ id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'model',
        choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server');
  const pending: ModelMessage[] = [], replies: string[] = [];
  const context: RunContext = {
    runId: 'run', bot: { model: 'model' } as RunContext['bot'],
    connection: { provider: 'custom', protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, authMode: 'none' } as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: 'Original requirements',
    messages: [], instructions: 'Help',
    tools: ['write', 'verify', 'ask_user'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
    signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
    executeTool: async () => ({ saved: true }), getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
    resolveImage: async () => ({ mimeType: 'image/png', data: 'aW1hZ2U=' }),
    userInput: { take: () => pending.splice(0), hasPending: () => !!pending.length, subscribe: () => () => {},
      beginReply: text => { replies.push(text ?? ''); } },
  };
  return { context, pending, replies, requests };
}

function requestMessages(request: Record<string, any>, protocol: Protocol): any[] {
  return protocol === 'responses' ? request.input : request.messages.filter((item: any) => item.role !== 'system');
}

describe.each(['responses', 'chat-completions'] as const)('managed supplemental messages via %s', protocol => {
  it('takes pending messages before the first request and preserves image and source references', async () => {
    const { context, pending, replies, requests } = await fixture(protocol, () => ({ text: 'Revised answer' }));
    pending.push(followup());
    const result = await new CustomApiAdapter().run(context);
    expect(result.text).toBe('Revised answer'); expect(replies).toEqual(['']); expect(requests).toHaveLength(1);
    expect(result.messages?.[1]).toEqual(followup());
    const inputs = requestMessages(requests[0], protocol);
    expect(inputs.map(item => item.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(inputs[1])).toContain('data:image/png;base64,aW1hZ2U=');
  });

  it('appends supplements after every tool return and continues the existing run', async () => {
    const { context, pending, replies, requests } = await fixture(protocol, index => index === 1
      ? { text: 'Initial progress', tools: ['write', 'verify'] } : { text: 'Revised answer' });
    const executed: string[] = [];
    context.executeTool = async name => {
      executed.push(name);
      if (name === 'write') pending.push(followup());
      expect(replies).toEqual([]);
      return { operation: name };
    };
    const result = await new CustomApiAdapter().run(context);
    expect(executed).toEqual(['write', 'verify']); expect(requests).toHaveLength(2);
    expect(replies).toEqual(['Initial progress']); expect(result.text).toBe('Revised answer');
    expect(result.messages?.map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    const inputs = requestMessages(requests[1], protocol);
    if (protocol === 'responses') {
      expect(inputs.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['call-1-0', 'call-1-1']);
      expect(inputs.at(-2)).toMatchObject({ type: 'function_call_output', call_id: 'call-1-1' });
    } else {
      expect(inputs.map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
      expect(inputs[1].tool_calls.map((item: any) => item.id)).toEqual(inputs.slice(2, 4).map(item => item.tool_call_id));
    }
    expect(inputs.at(-1).role).toBe('user');
    expect(result.messages?.[4]).toEqual(followup());
  });

  it('continues after a terminal answer when a supplement arrived during that request', async () => {
    let pending: ModelMessage[];
    const scenario = await fixture(protocol, index => {
      if (index === 1) pending.push(followup());
      return { text: index === 1 ? 'Original answer' : 'Revised answer' };
    });
    pending = scenario.pending;
    const result = await new CustomApiAdapter().run(scenario.context);
    expect(result.text).toBe('Revised answer'); expect(scenario.replies).toEqual(['Original answer']);
    expect(scenario.requests).toHaveLength(2);
    expect(requestMessages(scenario.requests[1], protocol).map(item => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.messages?.map(item => item.content)).toEqual(['Original requirements', 'Original answer', 'Use the revised requirements', 'Revised answer']);
  });

  it('yields structured questions with paired returns and leaves supplements unclaimed', async () => {
    const { context, pending, replies, requests } = await fixture(protocol, () => ({ tools: ['ask_user', 'write'] }));
    const input = new AbortController(); context.inputSignal = input.signal;
    const executed: string[] = [];
    context.executeTool = async name => {
      executed.push(name); pending.push(followup()); input.abort(); return { waitingForInput: true };
    };
    const result = await new CustomApiAdapter().run(context);
    expect(result.outcome).toBe('waiting_input'); expect(requests).toHaveLength(1);
    expect(executed).toEqual(['ask_user']); expect(pending).toEqual([followup()]); expect(replies).toEqual([]);
    expect(result.messages?.map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(result.messages?.at(-1)?.content).toContain('未执行');
  });
});

describe('supplemental messages and context recovery', () => {
  it('rejects recovery that discards original-run tools before the inserted user message', async () => {
    const { context, pending, requests } = await fixture('responses', index => index === 1
      ? { tools: ['write'] } : { overflow: true });
    context.messages = [{ role: 'user', content: 'old'.repeat(1000) }, { role: 'assistant', content: 'Old answer' }];
    context.executeTool = async () => { pending.push(followup()); return { saved: true }; };
    context.compactContext = async (messages, { force }) => force
      ? { messages: [messages.at(-1)!], currentStart: 0 } : undefined;
    await expect(new CustomApiAdapter().run(context)).rejects.toThrow('未保留用户输入与完整工具配对');
    expect(requests).toHaveLength(2);
  });

  it('keeps complete original-run tool pairs and supplements through a smaller recovery', async () => {
    const { context, pending, requests } = await fixture('responses', index => index === 1
      ? { tools: ['write'] } : index === 2 ? { overflow: true } : { text: 'Revised answer' });
    context.messages = [{ role: 'user', content: 'old'.repeat(1000) }, { role: 'assistant', content: 'Old answer' }];
    let writes = 0;
    context.executeTool = async () => { writes++; pending.push(followup()); return { saved: true }; };
    context.compactContext = async (messages, { force, currentStart }) => force
      ? { messages: [{ role: 'user', content: 'Summary' }, ...messages.slice(2)], currentStart: currentStart - 1 } : undefined;
    const result = await new CustomApiAdapter().run(context);
    expect(result.text).toBe('Revised answer'); expect(writes).toBe(1); expect(requests).toHaveLength(3);
    expect(requests[2].input).toContainEqual({ type: 'function_call_output', call_id: 'call-1-0', output: '{"saved":true}' });
    expect(result.messages?.find(item => item.sourceMessageId === 'supplement')).toEqual(followup());
  });
});
