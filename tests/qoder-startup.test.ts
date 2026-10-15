import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Qoder from '@qodercn-ai/qodercn-agent-sdk';
import type { RunContext } from '../src/domain/provider.js';
import { QoderAdapter } from '../src/providers/native/qoder.js';
import type { NativeInput } from '../src/providers/native/input.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-qoder-startup-')); folders.push(root);
  const workspace = join(root, 'workspace'), profile = join(root, 'profile');
  await mkdir(workspace); await mkdir(profile);
  const initialized = deferred<void>(), nativeInit = deferred<void>(), image = deferred<{ mimeType: string; data: string }>();
  const account = deferred<{ userId: string }>(), models = deferred<{ value: string }[]>();
  const mcp = deferred<{ name: string; status: string }[]>();
  const calls: string[] = [], prompts: Qoder.SDKUserMessage[] = [];
  let closed = false;
  const sdk = { accessToken: () => ({ type: 'accessToken', token: 'fixture-only' }), ProcessTransport: { default: {} },
    query: ({ prompt, options }: { prompt: NativeInput<Qoder.SDKUserMessage>; options: Qoder.Options }) => {
      const stream = (async function* () {
        await nativeInit.promise;
        if (closed) return;
        yield { type: 'system', subtype: 'init', session_id: options.sessionId, cwd: options.cwd };
        for await (const message of prompt) {
          prompts.push(message);
          yield { type: 'result', subtype: 'success', session_id: options.sessionId, result: 'done',
            usage: { input_tokens: 1, output_tokens: 1 } };
        }
      })();
      return Object.assign(stream, {
        initializationResult: () => { calls.push('init'); return initialized.promise.then(() => ({ capabilities: [] })); },
        accountInfo: () => { calls.push('account'); return account.promise; },
        getAvailableModels: () => { calls.push('models'); return models.promise; },
        mcpServerStatus: () => { calls.push('mcp'); return mcp.promise; },
        close: async () => { closed = true; prompt.close(); nativeInit.resolve(); }, interrupt: async () => {},
      });
    },
  } as unknown as typeof Qoder;
  const context: RunContext = {
    runId: 'run', workspacePath: workspace, prompt: 'task', instructions: 'instructions', signal: new AbortController().signal,
    bot: { id: 'bot', name: 'bot', role: 'research', instructions: '', connectionId: 'connection', model: 'model',
      color: 'blue', toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false },
    connection: { id: 'connection', name: 'qoder', provider: 'qoder', profilePath: profile, authMode: 'pat',
      concurrency: 1, status: 'ready', models: [], revision: 1, createdAt: '' },
    binding: { id: 'binding', botId: 'bot', connectionId: 'connection', conversationId: 'room', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'workspace', lastDeliveredSequence: 0 },
    messages: [], tools: [], images: [{ artifactId: 'image', mimeType: 'image/png' }],
    nativeMcp: { command: process.execPath, args: [], env: {} }, emit: () => {}, executeTool: async () => {},
    getSecret: async () => 'fixture-only', saveSecret: async () => {}, persistBinding: () => {},
    resolveImage: async () => { calls.push('image'); return image.promise; },
  };
  return { adapter: new QoderAdapter(async () => sdk), context, calls, prompts, initialized, nativeInit, image,
    account, models, mcp, closed: () => closed };
}

describe('Qoder preparation', () => {
  it('overlaps images with initialization and sends only after all parallel checks succeed', async () => {
    const test = await fixture(), running = test.adapter.run(test.context);
    await expect.poll(() => test.calls).toEqual(['init', 'image']);
    test.initialized.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(test.calls).toEqual(['init', 'image']);
    test.nativeInit.resolve();
    await expect.poll(() => test.calls).toEqual(['init', 'image', 'account', 'models', 'mcp']);
    test.models.resolve([{ value: 'model' }]); test.mcp.resolve([{ name: 'ai-team', status: 'connected' }]);
    test.image.resolve({ mimeType: 'image/png', data: 'fixture-image' });
    expect(test.prompts).toHaveLength(0);
    test.account.resolve({ userId: 'fixture-account' });
    expect(await running).toMatchObject({ text: 'done' });
    expect(test.prompts).toHaveLength(1);
    expect(test.prompts[0].message.content).toEqual([{ type: 'text', text: 'task' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture-image' } }]);
    expect(test.closed()).toBe(true);
  });

  it.each(['account', 'models', 'mcp', 'image'] as const)('closes preparation without input when %s fails', async source => {
    const test = await fixture(), running = test.adapter.run(test.context);
    const rejection = expect(running).rejects.toThrow('fixture failure');
    await expect.poll(() => test.calls).toContain('image');
    test.initialized.resolve(); test.nativeInit.resolve();
    await expect.poll(() => test.calls).toContain('mcp');
    test[source].reject(new Error('fixture failure'));
    await rejection;
    expect(test.prompts).toHaveLength(0); expect(test.closed()).toBe(true);
  });

  it('cancels while images and control requests are pending', async () => {
    const test = await fixture(), controller = new AbortController(); test.context.signal = controller.signal;
    const running = test.adapter.run(test.context), rejection = expect(running).rejects.toThrow('cancelled');
    await expect.poll(() => test.calls).toContain('image');
    test.initialized.resolve(); test.nativeInit.resolve();
    await expect.poll(() => test.calls).toContain('mcp');
    controller.abort(new Error('cancelled'));
    await rejection;
    expect(test.prompts).toHaveLength(0); expect(test.closed()).toBe(true);
  });

  it('cancels an outstanding image read after every control check has passed', async () => {
    const test = await fixture(), controller = new AbortController(); test.context.signal = controller.signal;
    const running = test.adapter.run(test.context), rejection = expect(running).rejects.toThrow('cancelled');
    await expect.poll(() => test.calls).toContain('image');
    test.initialized.resolve(); test.nativeInit.resolve();
    test.account.resolve({ userId: 'fixture-account' }); test.models.resolve([{ value: 'model' }]);
    test.mcp.resolve([{ name: 'ai-team', status: 'connected' }]);
    await expect.poll(() => test.calls).toContain('mcp');
    controller.abort(new Error('cancelled'));
    await rejection;
    expect(test.prompts).toHaveLength(0); expect(test.closed()).toBe(true);
  });
});
