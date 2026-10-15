import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const opaque = { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] };
const call = { type: 'function_call', id: 'fc', call_id: 'call1', name: 'write', arguments: '{}', status: 'completed' };
const answer = { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Saved', annotations: [] }] };

async function fixture(handler: (request: Record<string, unknown>, index: number) => { code?: string; output?: unknown[] }) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const response = handler(requests.at(-1)!, requests.length);
    if (response.code) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: response.code, message: 'rejected' } }));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'response', status: 'completed', output: response.output ?? [answer] } })}\n\n`);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server');
  const context: RunContext = {
    runId: 'run', bot: { model: 'model' } as RunContext['bot'],
    connection: { provider: 'custom', protocol: 'responses', baseUrl: `http://127.0.0.1:${address.port}/v1`, authMode: 'none' } as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: 'Save file',
    messages: [{ role: 'user', content: 'old'.repeat(1000) }, { role: 'assistant', content: 'Old answer' }], instructions: 'Help',
    tools: [{ name: 'write', description: 'Write', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
    executeTool: async () => ({ saved: true }), getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
  };
  return { context, requests };
}

describe('managed context overflow recovery', () => {
  it('recovers once after executing a tool, retaining opaque items and results without repeating the write', async () => {
    const { context, requests } = await fixture((_request, index) => index === 1 ? { output: [opaque, call] }
      : index === 2 ? { code: 'context_length_exceeded' } : { output: [answer] });
    let writes = 0, recoveries = 0;
    context.executeTool = async () => { writes++; return { saved: true }; };
    context.recoverContext = async messages => { recoveries++; return [{ role: 'user', content: 'Summary' }, ...messages.slice(2)]; };
    const result = await new CustomApiAdapter().run(context);
    expect(result.text).toBe('Saved');
    expect(writes).toBe(1); expect(recoveries).toBe(1); expect(requests).toHaveLength(3);
    expect(requests[2].input).toContainEqual(opaque);
    expect(requests[2].input).toContainEqual({ type: 'function_call_output', call_id: 'call1', output: '{"saved":true}' });
  });

  it('does not compact for unrelated 400 errors', async () => {
    const { context, requests } = await fixture(() => ({ code: 'invalid_parameter' }));
    let recoveries = 0;
    context.recoverContext = async () => { recoveries++; return []; };
    await expect(new CustomApiAdapter().run(context)).rejects.toThrow();
    expect(recoveries).toBe(0); expect(requests).toHaveLength(1);
  });

  it('stops after the single recovery attempt also overflows', async () => {
    const { context, requests } = await fixture(() => ({ code: 'context_window_exceeded' }));
    let recoveries = 0;
    context.recoverContext = async messages => { recoveries++; return messages.slice(2); };
    await expect(new CustomApiAdapter().run(context)).rejects.toThrow('压缩恢复后仍超过');
    expect(recoveries).toBe(1); expect(requests).toHaveLength(2);
  });

  it('refuses recovery that drops completed tool items', async () => {
    const { context, requests } = await fixture((_request, index) => index === 1 ? { output: [opaque, call] } : { code: 'context_length_exceeded' });
    let writes = 0;
    context.executeTool = async () => { writes++; return { saved: true }; };
    context.recoverContext = async () => [{ role: 'user', content: context.prompt }];
    await expect(new CustomApiAdapter().run(context)).rejects.toThrow('未保留当前完整轮次');
    expect(writes).toBe(1); expect(requests).toHaveLength(2);
  });
});
