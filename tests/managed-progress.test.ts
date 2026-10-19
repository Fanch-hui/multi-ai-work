import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedProgress, ProviderEvent, RunContext } from '../src/domain/provider.js';
import { ModelRecoveryPendingError } from '../src/domain/recovery.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
const call = (id: string) => ({ type: 'function_call', id: `item-${id}`, call_id: id,
  name: 'write', arguments: '{}', status: 'completed' });
const output = { type: 'message', id: 'answer', status: 'completed', role: 'assistant',
  content: [{ type: 'output_text', text: '完成', annotations: [] }] };
const completed = (items: unknown[] = [output]) => ({ type: 'response.completed', response: {
  id: 'response', status: 'completed', output: items, usage: { input_tokens: 10, output_tokens: 2 } } });
const overloaded = { type: 'error', code: 'server_is_overloaded', message: 'busy' };

describe('managed durable protocol progress', () => {
  it('saves a full assistant before tools and each real tool result before the next call', async () => {
    const saved: ManagedProgress[] = [];
    const { context, requests } = await fixture(index => {
      expect(saved.at(-1)?.phase).toBe('request');
      return [completed(index === 0 ? [call('one'), call('two')] : [output])];
    });
    context.saveProgress = async progress => { saved.push(structuredClone(progress)); };
    const writes: string[] = [];
    context.executeTool = async (_name, _args, id) => {
      const progress = saved.at(-1)!;
      expect(progress.phase).toBe('tools');
      expect(progress.messages.filter(message => message.role === 'assistant').at(-1)?.providerItems).toEqual([call('one'), call('two')]);
      expect(progress.messages.filter(message => message.role === 'tool').map(message => message.callId)).toEqual(writes);
      writes.push(id); return { written: id };
    };
    const result = await runManaged(createClient(context.connection.baseUrl!), context, 'responses', []);
    expect(writes).toEqual(['one', 'two']); expect(requests).toHaveLength(2);
    expect(result.text).toBe('完成'); expect(saved.at(-1)?.phase).toBe('complete');
    expect(saved.filter(progress => progress.phase === 'request').map(progress => progress.attempt)).toEqual([0, 0]);
    expect(new Set(saved.filter(progress => progress.phase === 'request').map(progress => progress.turnId)).size).toBe(2);
  });

  it('resumes a partially paired tool batch and skips the already saved write', async () => {
    let checkpoint!: ManagedProgress;
    const { context, requests } = await fixture(index => [completed(index === 0 ? [call('one'), call('two')] : [output])]);
    const writes: string[] = [];
    context.executeTool = async (_name, _args, id) => { writes.push(id); return { written: id }; };
    context.saveProgress = async progress => {
      checkpoint = structuredClone(progress);
      if (progress.phase === 'tools' && progress.messages.some(message => message.role === 'tool')) throw new Error('simulated exit');
    };
    await expect(runManaged(createClient(context.connection.baseUrl!), context, 'responses', []))
      .rejects.toThrow('simulated exit');
    expect(writes).toEqual(['one']); expect(checkpoint.phase).toBe('tools');
    context.progress = checkpoint; context.runId = 'resumed';
    context.saveProgress = async progress => { checkpoint = structuredClone(progress); };
    const result = await runManaged(createClient(context.connection.baseUrl!), context, 'responses', []);
    expect(writes).toEqual(['one', 'two']); expect(requests).toHaveLength(2);
    expect(result.text).toBe('完成');
    expect(result.messages?.filter(message => message.role === 'tool').map(message => message.callId)).toEqual(['one', 'two']);
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  it('saves the compacted request before dispatch and resumes with full original tool evidence', async () => {
    const { context, requests } = await fixture(index => [completed(index < 2 ? [call(index ? 'two' : 'one')] : [output])]);
    const writes: string[] = [];
    let saved!: ManagedProgress, interrupted = false;
    context.executeTool = async (_name, _args, id) => { writes.push(id); return { written: id, detail: 'evidence '.repeat(500) }; };
    context.compactContext = async (messages, options) => messages.filter(message => message.role === 'tool').length < 2
      ? undefined : { messages: [messages[0], { role: 'assistant', content: 'First result saved', contextSummary: true }, ...messages.slice(-2)],
        currentStart: options.currentStart };
    context.saveProgress = async progress => {
      saved = structuredClone(progress);
      if (progress.compaction && progress.phase === 'ready' && !interrupted) {
        interrupted = true;
        throw new Error('exit after durable compaction');
      }
    };
    await expect(runManaged(createClient(context.connection.baseUrl!), context, 'responses', [])).rejects.toThrow('durable compaction');
    expect(requests).toHaveLength(2);
    expect(saved.compaction?.archived.filter(message => message.role === 'tool')).toHaveLength(2);
    context.progress = saved;
    const result = await runManaged(createClient(context.connection.baseUrl!), context, 'responses', []);
    expect(requests).toHaveLength(3);
    expect(writes).toEqual(['one', 'two']);
    expect(JSON.stringify(requests[2])).not.toContain('item-one');
    expect(result.messages?.filter(message => message.role === 'tool').map(message => message.callId)).toEqual(['one', 'two']);
    expect(result.contextMessages?.filter(message => message.role === 'tool').map(message => message.callId)).toEqual(['two']);
    expect(result.text).toBe('完成');
  });

  it('returns a saved complete reply without sending a new request or recounting old usage', async () => {
    const { context, requests } = await fixture(() => [completed()]);
    context.progress = progress('complete', 4);
    context.progress.messages.push({ role: 'assistant', content: '已完成' });
    context.progress.text = '已完成'; context.progress.pendingInputIds = ['input'];
    const acknowledged: string[] = [];
    context.userInput = { take: () => [], hasPending: () => false, subscribe: () => () => {}, beginReply: () => {},
      acknowledge: ids => { acknowledged.push(...ids); } };
    let saved!: ManagedProgress;
    context.saveProgress = async value => { saved = structuredClone(value); };
    const result = await runManaged(createClient(context.connection.baseUrl!), context, 'responses', []);
    expect(requests).toHaveLength(0); expect(result.text).toBe('已完成');
    expect(result.usage).toBeUndefined(); expect(result.modelDurationMs).toBe(0);
    expect(acknowledged).toEqual(['input']); expect(saved.pendingInputIds).toEqual([]);
  });

  it('retains the saved retry budget across new runs', async () => {
    const { context, requests } = await fixture(() => [overloaded]);
    context.progress = progress('ready', 3);
    const events: ProviderEvent[] = []; const saved: ManagedProgress[] = [];
    context.emit = event => { events.push(event); };
    context.saveProgress = async value => { saved.push(structuredClone(value)); };
    await expect(runManaged(createClient(context.connection.baseUrl!), context, 'responses', [1, 1, 1, 1, 1]))
      .rejects.toThrow('模型返回错误事件');
    expect(requests).toHaveLength(3);
    expect(events.filter(event => event.data.phase === 'model-retry').map(event => event.data.attempt)).toEqual([4, 5]);
    expect(saved.filter(value => value.phase === 'request').map(value => value.attempt)).toEqual([3, 4, 5]);
    expect(new Set(saved.map(value => value.turnId))).toEqual(new Set(['original-turn']));
  });

  it('persists recovery before deferring a wait of at least ten seconds', async () => {
    const { context, requests } = await fixture(() => [overloaded]);
    context.progress = progress('ready', 2); context.deferRecovery = true;
    let saved!: ManagedProgress;
    context.saveProgress = async value => { await Promise.resolve(); saved = structuredClone(value); };
    let failure: unknown;
    try { await runManaged(createClient(context.connection.baseUrl!), context, 'responses'); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ModelRecoveryPendingError);
    expect(saved).toMatchObject({ phase: 'ready', attempt: 3, turnId: 'original-turn',
      recovery: { attempt: 3, maxAttempts: 5 } });
    expect(saved.recovery).toEqual((failure as ModelRecoveryPendingError).recovery);
    expect(requests).toHaveLength(1);
  });

  it('does not dispatch a request if saving its input fails', async () => {
    const { context, requests } = await fixture(() => [completed()]);
    context.saveProgress = async () => { throw new Error('storage failed'); };
    await expect(runManaged(createClient(context.connection.baseUrl!), context, 'responses', [1]))
      .rejects.toThrow('storage failed');
    expect(requests).toHaveLength(0);
  });

  it.each(['context recovery', 'checkpoint save'])('takes new requirements arriving during %s before sending the next request', async window => {
    const { context, requests } = await fixture(index => window === 'context recovery' && index === 0
      ? [{ type: 'error', code: 'context_length_exceeded', message: 'context too long' }] : [completed()]);
    let pending = false;
    const replies: string[] = [];
    context.messages = [{ role: 'user', content: 'history '.repeat(200) }];
    context.userInput = { hasPending: () => pending, subscribe: () => () => {}, beginReply: output => { if (output) replies.push(output); },
      take: () => { if (!pending) return []; pending = false; return [{ role: 'user', content: 'REVISED', sourceMessageId: 'revised' }]; } };
    if (window === 'context recovery') context.compactContext = async (messages, { force, currentStart }) => {
      if (!force) return;
      pending = true;
      return { messages: [{ role: 'user', content: 'summary' }, ...messages.slice(context.messages.length)], currentStart };
    };
    else context.saveProgress = async progress => {
      if (progress.phase === 'request' && !progress.messages.some(message => message.sourceMessageId === 'revised')) pending = true;
    };
    await runManaged(createClient(context.connection.baseUrl!), context, 'responses', []);
    expect(requests).toHaveLength(window === 'context recovery' ? 2 : 1);
    expect(JSON.stringify(requests.at(-1))).toContain('REVISED');
    expect(replies).toEqual([]);
  });

  it('does not make a seventh request when the persisted budget is already exhausted', async () => {
    const { context, requests } = await fixture(() => [completed()]);
    context.progress = progress('ready', 6);
    await expect(runManaged(createClient(context.connection.baseUrl!), context, 'responses'))
      .rejects.toThrow('自动恢复次数已耗尽');
    expect(requests).toHaveLength(0);
  });
});

function progress(phase: ManagedProgress['phase'], attempt: number): ManagedProgress {
  return { messages: [{ role: 'user', content: 'original input', sourceMessageId: 'original' }],
    currentStart: 0, text: '', pendingInputIds: [], turnId: 'original-turn', attempt, phase };
}

async function fixture(events: (index: number) => unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const index = requests.push(JSON.parse(body)) - 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events(index).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server');
  const context: RunContext = {
    runId: 'run', bot: { model: 'model' } as RunContext['bot'],
    connection: { baseUrl: `http://127.0.0.1:${address.port}/v1` } as RunContext['connection'],
    binding: {} as RunContext['binding'], workspacePath: '/workspace', prompt: 'hello', messages: [], instructions: '',
    tools: [{ name: 'write', description: 'write', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {},
    executeTool: async () => undefined, getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: () => {},
  };
  return { context, requests };
}
