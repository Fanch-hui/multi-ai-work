import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk';
import type { ModelMessage, RunContext, RunUserInput } from '../src/domain/provider.js';
import { QoderAdapter } from '../src/providers/native/qoder.js';
import { QoderInput } from '../src/providers/native/qoder-input.js';
import { QoderEvents } from '../src/providers/native/qoder-events.js';
import { NativeInput } from '../src/providers/native/input.js';
import { runAntigravitySession } from '../src/providers/native/antigravity-session.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function directory() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'multi-ai-native-input-')));
  folders.push(folder); return folder;
}

class Inbox implements RunUserInput {
  messages: ModelMessage[] = [];
  replies: (string | undefined)[] = [];
  acknowledged: string[] = [];
  listeners = new Set<() => void>();
  take() { return this.messages.splice(0); }
  acknowledge(messageIds: string[]) { this.acknowledged.push(...messageIds); }
  hasPending() { return this.messages.length > 0; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  beginReply(output?: string) { this.replies.push(output); }
  send(content: string) {
    this.messages.push({ role: 'user', content, sourceMessageId: 'supplement', sourceSequence: 2 });
    for (const listener of this.listeners) listener();
  }
}

const cli = `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => console.log(JSON.stringify(value));
const id = 'session'; let turn = 0;
send({event:'init', conversation_id:id, init:{cwd:process.cwd(), tools:[], permission_mode:'request-review'}});
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
  const request = JSON.parse(line); turn++;
  appendFileSync(process.argv[2], JSON.stringify({pid:process.pid, request})+'\\n');
  send({event:'step_update', step_update:{conversation_id:id,step_index:turn,state:'DONE',step_type:'agent_response',text_delta:turn===1?'first':'second'}});
  send({event:'result', result:{conversation_id:id,status:'SUCCESS',response:turn===1?'first':'second',usage:{input_tokens:100+turn*10,output_tokens:10+turn}}});
});
input.on('close', () => process.exit(0));
`;

describe('native run supplemental input', () => {
  it.each(['waiting', 'cancelled'])('does not send Qoder supplemental input after %s during image loading', async state => {
    const inbox = new Inbox(), context = makeContext(await directory(), inbox);
    const controller = new AbortController(), inputController = new AbortController();
    context.signal = controller.signal; context.inputSignal = inputController.signal;
    let waiting = false, started!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const image = new Promise<void>(resolve => { finish = resolve; });
    context.isWaitingForInput = () => waiting;
    context.resolveImage = async () => { started(); await image; return { mimeType: 'image/png', data: 'fixture' }; };
    inbox.messages.push({ role: 'user', content: 'correction', images: [{ artifactId: 'image', mimeType: 'image/png' }] });
    const input = new NativeInput<QoderSdk.SDKUserMessage>();
    const received = input[Symbol.asyncIterator]().next();
    const pending = new QoderInput(context, input, 'session', new QoderEvents(context));
    pending.start(); await reading;
    if (state === 'waiting') { waiting = true; inputController.abort(new Error('waiting')); }
    else controller.abort(new Error('cancelled'));
    finish();
    if (state === 'cancelled') await expect(pending.flush()).rejects.toThrow('cancelled');
    else await pending.flush();
    pending.stop(); input.close();
    expect(await received).toEqual({ value: undefined, done: true });
    expect(pending.hasOutstanding()).toBe(false);
  });

  it('continues agy in one process, separates replies and sums resumed per-turn usage', async () => {
    const folder = await directory(), executable = join(folder, 'cli.mjs'), marker = join(folder, 'input.jsonl');
    await writeFile(executable, cli);
    const inbox = new Inbox(), text: string[] = [];
    const output = await runAntigravitySession({ executable, args: [marker], cwd: folder,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal: AbortSignal.timeout(5000), prompt: 'original',
      expectedSessionId: 'session', previousUsage: { input_tokens: 100, output_tokens: 10 },
      beforePrompt: async () => {}, userInput: inbox,
      onEvent: event => { if (event.type === 'text') { text.push(String(event.data.delta)); if (text.length === 1) inbox.send('correction'); } },
    });
    expect(output).toMatchObject({ text: 'second', nativeSessionId: 'session', usage: { inputTokens: 20, outputTokens: 2 } });
    expect(inbox.replies).toEqual(['first']); expect(text).toEqual(['first', 'second']);
    expect(inbox.acknowledged).toEqual(['supplement']);
    const submitted = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(submitted.map(value => value.request.message.content)).toEqual(['original', 'correction']);
    expect(new Set(submitted.map(value => value.pid)).size).toBe(1);
  });

  it.each([false, true])('keeps Qoder alive across a supplemental echo arriving before the first result: %s', async earlyEcho => {
    const folder = await directory(), inbox = new Inbox();
    const sent: QoderSdk.SDKUserMessage[] = [], emitted: string[] = [];
    let queryCount = 0, closed = false;
    const context = makeContext(folder, inbox);
    context.emit = event => { if (event.type === 'text') { emitted.push(String(event.data.delta)); if (emitted.length === 1) inbox.send('correction'); } };
    const sdk = {
      accessToken: () => ({}), ProcessTransport: { default: {} },
      query: ({ prompt, options }: { prompt: AsyncIterable<QoderSdk.SDKUserMessage>; options: QoderSdk.Options }) => {
        queryCount++; const id = options.sessionId!;
        const result = (text: string) => ({ type: 'result', subtype: 'success', session_id: id,
          is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 2 } });
        const assistant = (text: string) => ({ type: 'assistant', session_id: id, parent_tool_use_id: null,
          message: { content: [{ type: 'text', text }] } });
        const iterator = (async function* () {
          yield { type: 'system', subtype: 'init', session_id: id, cwd: folder };
          const inputs = prompt[Symbol.asyncIterator]();
          const first = (await inputs.next()).value!; sent.push(first); yield first;
          yield assistant('first');
          const second = (await inputs.next()).value!; sent.push(second);
          if (earlyEcho) yield second;
          yield result('first');
          if (!earlyEcho) yield second;
          yield assistant('second'); yield result('second');
        })();
        return Object.assign(iterator, {
          initializationResult: async () => ({ capabilities: [] }), accountInfo: async () => ({ userId: 'fixture-user' }),
          getAvailableModels: async () => [{ value: 'model' }], mcpServerStatus: async () => [{ name: 'ai-team', status: 'connected' }],
          interrupt: async () => {}, close: async () => { closed = true; },
        });
      },
    } as unknown as typeof QoderSdk;
    const adapter = new QoderAdapter(async () => sdk);
    const output = await adapter.run(context);
    expect(queryCount).toBe(1); expect(closed).toBe(true);
    expect(sent).toHaveLength(2); expect(sent[1]).toMatchObject({ priority: 'next', session_id: context.binding.nativeSessionId });
    expect(sent[1]!.uuid).not.toBe(sent[0]!.uuid);
    expect(output.text).toBe('second'); expect(output.usage).toMatchObject({ inputTokens: 20, outputTokens: 4 });
    expect(inbox.replies).toEqual(['first']); expect(inbox.listeners.size).toBe(0);
    expect(inbox.acknowledged).toEqual(['supplement']);
    expect(emitted).toEqual(['first', 'second']);
  });
});

function makeContext(folder: string, userInput: RunUserInput): RunContext {
  return { runId: 'run', workspacePath: folder, prompt: 'original', instructions: '', messages: [], tools: [], userInput,
    signal: AbortSignal.timeout(5000), nativeMcp: { command: 'fixture', args: [], env: {} },
    connection: { id: 'connection', name: 'Qoder', provider: 'qoder', authMode: 'pat', secretRef: 'fixture',
      profilePath: folder, status: 'ready', models: [], concurrency: 1, revision: 1, createdAt: '' },
    bot: { id: 'bot', name: 'Bot', role: '', instructions: '', connectionId: 'connection', model: 'model',
      color: 'blue', toolNames: [], skillIds: [], memoryMode: 'off', revision: 1, archived: false },
    binding: { id: 'binding', botId: 'bot', conversationId: 'conversation', connectionId: 'connection', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'workspace', lastDeliveredSequence: 0 },
    emit: () => {}, executeTool: async () => {}, getSecret: async () => 'fixture-only', saveSecret: async () => {},
    persistBinding(nativeSessionId) { this.binding.nativeSessionId = nativeSessionId; },
  };
}
