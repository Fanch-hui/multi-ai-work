import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { ModelRequest } from '../src/providers/managed/request.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe('completed Chat stream tails', () => {
  it('keeps a fixed deadline for usage after completion even when more metadata arrives', () => {
    vi.useFakeTimers();
    const events: ProviderEvent[] = [];
    const request = new ModelRequest({ signal: new AbortController().signal, emit: event => { events.push(event); } });
    request.complete();
    vi.advanceTimersByTime(600);
    request.activity('chat.chunk', false, 'waiting'); request.complete();
    vi.advanceTimersByTime(400);
    expect(request.signal.aborted).toBe(true);
    expect(events.filter(event => event.data.phase !== 'performance')).toEqual([
      { type: 'status', data: { phase: 'model-activity', activity: 'chat.completed', activityKind: 'finishing' } },
    ]);
    request.close();
  });
  it('waits briefly for reported usage after finish_reason', async () => {
    const { context, requests } = await fixture('usage');
    const result = await runManaged(createClient(context.connection.baseUrl!), context, 'chat-completions', []);
    expect(result.text).toBe('完成'); expect(requests).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, source: 'reported' });
  });

  it.each(['reset', 'hang'] as const)('accepts a complete reply when the usage tail ends with %s', async mode => {
    const { context, requests } = await fixture(mode);
    const result = await runManaged(createClient(context.connection.baseUrl!), context, 'chat-completions', []);
    expect(result.text).toBe('完成'); expect(requests).toHaveLength(1);
    expect(result.usage).toEqual({ source: 'unknown' });
  });

  it('rejects an explicit incomplete finish without waiting for a hanging tail or retrying', async () => {
    const { context, requests } = await fixture('incomplete');
    const started = Date.now();
    await expect(runManaged(createClient(context.connection.baseUrl!), context, 'chat-completions', [1]))
      .rejects.toThrow('模型响应未完成：length');
    expect(Date.now() - started).toBeLessThan(1000); expect(requests).toHaveLength(1);
  });
});

async function fixture(mode: 'usage' | 'reset' | 'hang' | 'incomplete') {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '完成' },
      finish_reason: mode === 'incomplete' ? 'length' : 'stop' }] })}\n\n`);
    if (mode === 'reset') setTimeout(() => response.destroy(), 20);
    if (mode === 'usage') setTimeout(() => {
      response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 } } })}\n\ndata: [DONE]\n\n`);
    }, 20);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server');
  const context: RunContext = {
    runId: 'run', bot: { model: 'model' } as RunContext['bot'],
    connection: { baseUrl: `http://127.0.0.1:${address.port}/v1` } as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: 'hello', messages: [], instructions: '',
    tools: [], signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
    executeTool: async () => undefined, getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
  };
  return { context, requests };
}
