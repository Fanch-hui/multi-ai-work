import { createInterface } from 'node:readline';
import type { ModelMessage, ProviderEvent, RunUserInput } from '../../domain/provider.js';
import type { Usage } from '../../domain/types.js';
import { antigravityImagePrompt } from '../images.js';
import { bounded, launch, stop } from './runtime.js';
import { AntigravityEvents, type AntigravityInitialization, type AntigravityTurn, type AntigravityUsage } from './antigravity-events.js';

export interface AntigravitySessionOptions {
  executable: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string;
  prompt: string; signal: AbortSignal; expectedSessionId?: string; previousUsage?: AntigravityUsage;
  inputSignal?: AbortSignal; isWaitingForInput?(): boolean;
  userInput?: RunUserInput;
  validateInput?(messages: ModelMessage[]): void;
  beforePrompt(initialization: AntigravityInitialization): Promise<void>;
  onEvent?(event: ProviderEvent): void;
  timeoutMs?: number;
}

export function antigravitySessionArgs(args: string[], sessionId?: string): string[] {
  if (args.some(arg => ['--continue', '-c', '--conversation'].includes(arg)
    || arg.startsWith('--conversation=') || arg.startsWith('--continue=')))
    throw new Error('Antigravity 会话恢复必须使用当前绑定的精确 ID');
  return [...args, ...(sessionId ? ['--conversation', sessionId] : [])];
}

export async function runAntigravitySession(options: AntigravitySessionOptions): Promise<AntigravityTurn & { outcome?: 'waiting_input' }> {
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const args = antigravitySessionArgs(options.args, options.expectedSessionId);
  const child = launch(options.executable, args, options.cwd, options.env);
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('exit', code => resolve(code));
    child.once('error', () => reject(new Error('无法启动 Antigravity CLI，请检查运行时路径')));
  });
  void exit.catch(() => {});
  const cancel = () => {
    if (process.platform === 'win32') void stop(child).catch(() => {});
    else child.kill('SIGINT');
  };
  signal.addEventListener('abort', cancel, { once: true });
  const events = new AntigravityEvents({ expectedSessionId: options.expectedSessionId,
    previousUsage: options.previousUsage, emit: options.onEvent });
  let waiting = false;
  const pause = () => {
    if (options.signal.aborted || !options.isWaitingForInput?.()) return;
    waiting = true; controller.abort(new Error('等待用户回答'));
  };
  const promptSent = () => {
    options.inputSignal?.addEventListener('abort', pause, { once: true });
    if (options.inputSignal?.aborted) pause();
  };
  try {
    const result = await bounded(consume(lines, events, { ...options, signal }, line => child.stdin.write(line), promptSent),
      signal, options.timeoutMs ?? 30 * 60 * 1000);
    child.stdin.end();
    const code = await bounded(exit, signal, 2000);
    if (code !== 0) throw new Error('Antigravity CLI 未正常结束当前轮次');
    return result;
  } catch (error) {
    options.signal.throwIfAborted();
    if (!waiting || error !== controller.signal.reason || !events.initialization) throw error;
    return { text: events.text, nativeSessionId: events.initialization.conversationId,
      usage: { source: 'unknown' }, outcome: 'waiting_input' };
  } finally {
    options.inputSignal?.removeEventListener('abort', pause);
    signal.removeEventListener('abort', cancel);
    controller.abort();
    lines.close();
    await stop(child);
  }
}

async function consume(lines: AsyncIterable<string>, events: AntigravityEvents,
  options: AntigravitySessionOptions, write: (line: string) => unknown, promptSent: () => void): Promise<AntigravityTurn> {
  const iterator = lines[Symbol.asyncIterator]();
  let sent = false;
  let submittedInputIds: string[] = [];
  const usages: Usage[] = [];
  while (true) {
    const item = await bounded(iterator.next(), options.signal, sent ? options.timeoutMs ?? 30 * 60 * 1000 : 35000);
    if (item.done) throw new Error('Antigravity 输出流在最终结果前结束');
    let event: unknown;
    try { event = JSON.parse(item.value); }
    catch { throw new Error('Antigravity 返回了无效 JSON 事件'); }
    const result = events.accept(event);
    if (!sent && events.initialization) {
      await bounded(options.beforePrompt(events.initialization), options.signal);
      options.signal.throwIfAborted();
      write(`${JSON.stringify({ event: 'user', message: { content: options.prompt } })}\n`);
      sent = true;
      promptSent();
    }
    if (result) {
      options.signal.throwIfAborted();
      if (submittedInputIds.length) options.userInput?.acknowledge?.(submittedInputIds);
      submittedInputIds = [];
      usages.push(result.usage);
      const messages = options.userInput?.take() ?? [];
      if (!messages.length) return { ...result, usage: sumUsage(usages) };
      options.validateInput?.(messages);
      options.userInput!.beginReply(result.text);
      events.nextTurn(result.cumulativeUsage);
      const prompt = messages.map(message => antigravityImagePrompt(message.content, message.images ?? [])).join('\n\n');
      submittedInputIds = messages.flatMap(message => message.sourceMessageId ? [message.sourceMessageId] : []);
      write(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
    }
  }
}

function sumUsage(usages: Usage[]): Usage {
  if (usages.length === 1) return usages[0]!;
  const total: Usage = { source: usages.every(usage => usage.source === 'reported') ? 'reported' : 'unknown' };
  for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    if (usages.every(usage => typeof usage[field] === 'number')) total[field] = usages.reduce((sum, usage) => sum + usage[field]!, 0);
  }
  return total;
}
