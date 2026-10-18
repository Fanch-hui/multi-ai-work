import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { RunContext, ProviderEvent } from '../src/domain/provider.js';
import type * as Qoder from '@qodercn-ai/qodercn-agent-sdk';
import { NativeInput } from '../src/providers/native/input.js';
import { QoderEvents } from '../src/providers/native/qoder-events.js';
import { QODER_MODEL_CACHE_TTL_MS, QoderAdapter, clearQoderModelCache, qoderOptions } from '../src/providers/native/qoder.js';
import { accountDigest, recordOwnership, validateOwnedAccount, validateOwnership } from '../src/providers/native/runtime.js';

const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  clearQoderModelCache();
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});
async function context(): Promise<RunContext & { events: ProviderEvent[] }> {
  const folder = await mkdtemp(join(tmpdir(), 'ai-team-native-test-')); folders.push(folder);
  const workspace = join(folder, 'workspace'), profile = join(folder, 'profile');
  await mkdir(workspace); await mkdir(profile);
  const events: ProviderEvent[] = [];
  const value: RunContext & { events: ProviderEvent[] } = {
    runId: '00000000-0000-4000-8000-000000000001', workspacePath: workspace, prompt: '当前任务', instructions: '保持研究员身份',
    bot: { id: 'bot', name: '研究员', role: 'research', instructions: '', connectionId: 'cn', model: 'model-a', color: '#666',
      toolNames: ['read_file'], skillIds: [], memoryMode: 'manual', revision: 1, archived: false },
    connection: { id: 'cn', name: '原生', provider: 'qoder', profilePath: profile, authMode: 'local', concurrency: 1,
      status: 'untested', models: [], revision: 1, createdAt: '' },
    binding: { id: 'binding', botId: 'bot', connectionId: 'cn', conversationId: 'private', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'workspace', lastDeliveredSequence: 0 },
    signal: new AbortController().signal, messages: [], tools: [{ name: 'read_file', description: 'read', inputSchema: {} }],
    nativeMcp: { command: process.execPath, args: ['server.mjs'], env: { AI_TEAM_SESSION: 'fixture-only' } },
    events, emit: event => events.push(event), executeTool: async () => { throw new Error('原生活动事件不得执行 App 工具'); },
    getSecret: async () => undefined, saveSecret: async () => {}, persistBinding: id => { value.binding.nativeSessionId = id; },
  };
  return value;
}

describe('native adapter isolation', () => {
  it('keeps async input open between messages until host closes it', async () => {
    const input = new NativeInput<string>(), iterator = input[Symbol.asyncIterator]();
    input.send('first'); expect(await iterator.next()).toEqual({ done: false, value: 'first' });
    const next = iterator.next(); input.send('second'); expect(await next).toEqual({ done: false, value: 'second' });
    const pending = iterator.next(); input.close(); expect(await pending).toEqual({ done: true, value: undefined });
  });

  it('rejects session reuse by another binding, workspace or account', async () => {
    const ctx = await context(); await recordOwnership(ctx, 'native-id', accountDigest('qoder-cn', 'account-a'));
    await validateOwnership(ctx);
    await expect(validateOwnedAccount(ctx, accountDigest('qoder-cn', 'account-b'))).rejects.toThrow('账号');
    ctx.binding.id = 'other-binding'; await expect(validateOwnership(ctx)).rejects.toThrow('身份');
  });

  it('configures Qoder without native memory, skills, agents or user settings', async () => {
    const ctx = await context(); const sdk = { qodercliAuth: () => ({ type: 'qodercli' }), ProcessTransport: { default: {} } } as unknown as typeof Qoder;
    const options = qoderOptions(ctx.connection, ctx.connection.profilePath!, ctx.workspacePath, sdk);
    expect(options.tools).toEqual([]); expect(options.agents).toEqual({}); expect(options.skills).toEqual([]);
    expect(options.memory).toEqual({}); expect(options.settingSources).toEqual([]);
    expect(options.env?.HOME).toBe(homedir());
    expect(options.env?.QODERCN_CONFIG_DIR).toBe(join(ctx.connection.profilePath!, '.qoder-cn'));
    expect(await options.canUseTool!('Bash', {}, { signal: ctx.signal, toolUseID: 'x' } as Qoder.CanUseToolOptions)).toMatchObject({ behavior: 'deny' });
  });

  it('keeps local Qoder login selected when a previously saved PAT still exists', async () => {
    const ctx = await context();
    const sdk = { qodercliAuth: () => ({ type: 'qodercli' }), ProcessTransport: { default: {} },
      accessToken: () => { throw new Error('local login must not use a PAT'); } } as unknown as typeof Qoder;
    expect(qoderOptions(ctx.connection, ctx.connection.profilePath!, ctx.workspacePath, sdk, 'old-test-pat').auth)
      .toEqual({ type: 'qodercli' });
  });

  it('does not duplicate full Qoder messages following partial deltas', async () => {
    const ctx = await context(); const projection = new QoderEvents(ctx);
    projection.accept({ type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null } as Qoder.SDKMessage);
    projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }, parent_tool_use_id: null } as Qoder.SDKMessage);
    projection.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] }, parent_tool_use_id: null } as Qoder.SDKMessage);
    expect(projection.text).toBe('answer'); expect(ctx.events.filter(event => event.type === 'text')).toHaveLength(1);
  });

  it('reports Qoder reasoning and tool arguments before visible text without exposing reasoning', async () => {
    const ctx = await context(); const projection = new QoderEvents(ctx);
    for (const delta of [{ type: 'thinking_delta', thinking: 'private-thought' },
      { type: 'thinking_delta', thinking: 'private-thought' }, { type: 'input_json_delta', partial_json: '{' },
      { type: 'text_delta', text: 'answer' }]) projection.accept({ type: 'stream_event',
      event: { type: 'content_block_delta', delta }, parent_tool_use_id: null } as Qoder.SDKMessage);
    expect(ctx.events.filter(event => event.data.phase === 'model-activity').map(event => event.data.activityKind))
      .toEqual(['thinking', 'tool', 'responding']);
    expect(projection.text).toBe('answer'); expect(JSON.stringify(ctx.events)).not.toContain('private-thought');
  });
});

function qoderFixture(account: () => string, completed: boolean, prompts: string[], opened: Qoder.Options[], onModels?: () => void) {
  return {
    qodercliAuth: () => ({ type: 'qodercli' }), ProcessTransport: { default: {} },
    query: ({ prompt, options }: { prompt: AsyncIterable<Qoder.SDKUserMessage>; options: Qoder.Options }) => {
      opened.push(options);
      const generator = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: options.resume ?? options.sessionId, cwd: options.cwd };
        for await (const value of prompt) {
          prompts.push(JSON.stringify(value));
          yield { type: 'result', subtype: completed ? 'success' : 'error_max_turns', is_error: !completed,
            session_id: options.resume ?? options.sessionId, result: 'done', usage: { input_tokens: 5, output_tokens: 2 } };
        }
      })();
      return Object.assign(generator, {
        initializationResult: async () => ({ capabilities: [] }), accountInfo: async () => ({ userId: account() }),
        getAvailableModels: async () => { onModels?.(); return [{ value: 'model-a', displayName: 'Model A' }]; },
        mcpServerStatus: async () => [{ name: 'ai-team', status: 'connected' }],
        close: async () => { (prompt as NativeInput<Qoder.SDKUserMessage>).close(); }, interrupt: async () => {},
      });
    },
  } as unknown as typeof Qoder;
}

describe('Qoder native turn boundaries', () => {
  it('resumes the exact session, passes App MCP, and checks account before sending another prompt', async () => {
    const ctx = await context(); ctx.connection.provider = 'qoder';
    let account = 'account-a'; const prompts: string[] = [], opened: Qoder.Options[] = [];
    const adapter = new QoderAdapter(async () => qoderFixture(() => account, true, prompts, opened));
    const first = await adapter.run(ctx); expect(first.text).toBe('done'); expect(prompts).toHaveLength(1);
    expect(opened[0].systemPrompt).toBe(ctx.instructions);
    expect(opened[0]).not.toHaveProperty('maxTurns');
    const sessionId = ctx.binding.nativeSessionId;
    ctx.instructions = '当前助手职责与资料'; ctx.prompt = '本轮长期记忆更新';
    await adapter.run(ctx);
    expect(opened[1].resume).toBe(sessionId); expect(opened[1].sessionId).toBeUndefined();
    expect(opened[0].mcpServers).toMatchObject({ 'ai-team': ctx.nativeMcp });
    expect(opened[1].systemPrompt).toBe(ctx.instructions);
    expect(JSON.parse(prompts[1]).message.content).toEqual([{ type: 'text', text: ctx.prompt }]);
    account = 'account-b'; await expect(adapter.run(ctx)).rejects.toThrow('账号');
    expect(prompts).toHaveLength(2); await adapter.close();
  });

  it('caches Qoder available models for 5 minutes and isolates by connectionId, cliPath, and profile', async () => {
    vi.useFakeTimers();
    const ctx = await context(); ctx.connection.provider = 'qoder';
    let modelCalls = 0;
    const adapter = new QoderAdapter(async () => qoderFixture(() => 'account-a', true, [], [], () => { modelCalls++; }));
    await adapter.run(ctx);
    expect(modelCalls).toBe(1);

    // Second run within 5-minute TTL reuses cached models without calling getAvailableModels again.
    await adapter.run(ctx);
    expect(modelCalls).toBe(1);

    // Changing cliPath (executable) or connectionId isolates the cache key.
    ctx.connection = { ...ctx.connection, executable: '/custom/qodercli' };
    await adapter.run(ctx);
    expect(modelCalls).toBe(2);

    const otherCtx = await context();
    otherCtx.connection = { ...otherCtx.connection, id: 'cn-other', provider: 'qoder' };
    otherCtx.binding = { ...otherCtx.binding, connectionId: 'cn-other' };
    await adapter.run(otherCtx);
    expect(modelCalls).toBe(3);

    // After 5-minute TTL expires, the next run refreshes the model catalog.
    vi.advanceTimersByTime(QODER_MODEL_CACHE_TTL_MS + 1);
    await adapter.run(otherCtx);
    expect(modelCalls).toBe(4);
    await adapter.close();
  });

  it('rejects an error terminal result instead of reporting completion', async () => {
    const ctx = await context(); ctx.connection.provider = 'qoder';
    const adapter = new QoderAdapter(async () => qoderFixture(() => 'account', false, [], []));
    await expect(adapter.run(ctx)).rejects.toThrow('未完成'); await adapter.close();
    expect(ctx.events.some(event => event.type === 'status' && event.data.stopReason)).toBe(false);
  });
});

function pausingQoder(toolsConnected = true) {
  let interrupts = 0, prompts = 0, finish!: () => void;
  const interrupted = new Promise<void>(resolve => { finish = resolve; });
  const sdk = {
    qodercliAuth: () => ({ type: 'qodercli' }), ProcessTransport: { default: {} },
    query: ({ prompt, options }: { prompt: NativeInput<Qoder.SDKUserMessage>; options: Qoder.Options }) => {
      const id = options.resume ?? options.sessionId;
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: id, cwd: options.cwd };
        for await (const _ of prompt) {
          prompts++;
          yield { type: 'assistant', session_id: id, parent_tool_use_id: null,
            message: { content: [{ type: 'text', text: '已提交问题' }] } };
          await interrupted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: id, is_error: true };
        }
      })();
      return Object.assign(stream, {
        initializationResult: async () => ({ capabilities: [] }), accountInfo: async () => ({ userId: 'test-account' }),
        getAvailableModels: async () => [{ value: 'model-a' }],
        mcpServerStatus: async () => [{ name: 'ai-team', status: toolsConnected ? 'connected' : 'failed' }],
        interrupt: async () => { interrupts++; finish(); }, close: async () => { prompt.close(); finish(); },
      });
    },
  } as unknown as typeof Qoder;
  return { adapter: new QoderAdapter(async () => sdk), interrupts: () => interrupts, prompts: () => prompts };
}

describe('Qoder input pause', () => {
  it('interrupts a submitted turn and keeps text and the exact persisted session', async () => {
    const ctx = await context(), input = new AbortController(), test = pausingQoder();
    ctx.inputSignal = input.signal; ctx.isWaitingForInput = () => true;
    ctx.emit = event => { ctx.events.push(event); if (event.type === 'text') input.abort(); };
    expect(await test.adapter.run(ctx)).toEqual({ text: '已提交问题', nativeSessionId: ctx.binding.nativeSessionId, outcome: 'waiting_input' });
    expect(test.interrupts()).toBe(1); expect(test.prompts()).toBe(1);
    await test.adapter.close();
  });

  it('does not bypass tool connectivity validation for an already requested pause', async () => {
    const ctx = await context(), input = new AbortController(), test = pausingQoder(false); input.abort();
    ctx.inputSignal = input.signal; ctx.isWaitingForInput = () => true;
    await expect(test.adapter.run(ctx)).rejects.toThrow('无法连接');
    expect(test.interrupts()).toBe(0); expect(test.prompts()).toBe(0);
    await test.adapter.close();
  });

  it('does not turn user cancellation into a waiting outcome', async () => {
    const ctx = await context(), input = new AbortController(), cancel = new AbortController(), test = pausingQoder();
    ctx.inputSignal = input.signal; ctx.signal = cancel.signal; ctx.isWaitingForInput = () => true;
    ctx.emit = event => { if (event.type === 'text') { input.abort(); cancel.abort(new Error('用户取消')); } };
    await expect(test.adapter.run(ctx)).rejects.toThrow('用户取消');
    await test.adapter.close();
  });
});
