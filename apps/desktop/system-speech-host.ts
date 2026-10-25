import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';
import { maxVoiceRecordingMs } from '../../src/domain/voice.js';
import type {
  SystemSpeechInput,
  SystemSpeechResult,
  SystemSpeechStatus,
} from '../../src/domain/system-speech.js';
import { systemSpeechLanguageSchema } from '../../src/domain/system-speech.js';

const execute = promisify(execFile);
const inputSchema = z.object({
  requestId: z.string().min(1).max(100),
  language: systemSpeechLanguageSchema,
});
const statusSchema = z.object({
  available: z.boolean(),
  locale: z.string(),
  authorization: z.enum(['authorized', 'not_determined', 'denied', 'restricted', 'unavailable']),
  reason: z.string().optional(),
});
interface Request {
  id: string;
  cancelled: boolean;
  promise: Promise<SystemSpeechResult>;
  resolve: (result: SystemSpeechResult) => void;
  reject: (error: Error) => void;
}
interface Active {
  request: Request;
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  stopping: boolean;
  fail: (cause: Error) => void;
}
export interface SpeechLaunch {
  command?: string;
  args?: string[];
  helperPath?: string;
  timeoutMs?: number;
  stopTimeoutMs?: number;
}

export class SystemSpeechHost {
  private active?: Active;
  private requests = new Map<string, Request>();
  private transitions: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private launch: SpeechLaunch) {}

  async status(preferredLanguage?: string): Promise<SystemSpeechStatus> {
    const parsed = systemSpeechLanguageSchema.safeParse(preferredLanguage);
    const locale = parsed.success ? parsed.data || '' : preferredLanguage || '';
    const unavailable = (reason: string): SystemSpeechStatus => ({
      available: false,
      locale,
      authorization: 'unavailable',
      reason,
    });
    if (!parsed.success) return unavailable('请在语音设置中填写语言代码，例如 zh-CN');
    if (!this.launch.command) return unavailable('请使用桌面应用或系统听写快捷键输入文字');
    if (this.launch.helperPath && !existsSync(this.launch.helperPath))
      return unavailable('系统语音组件尚未就绪，请更新 App');
    try {
      const result = await execute(this.launch.command, this.arguments('--status', locale), {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      });
      const status = statusSchema.parse(JSON.parse(result.stdout.trim()));
      return { ...status, reason: status.reason ? speechError(status.reason) : undefined };
    } catch {
      return unavailable('系统语音组件无法启动，请检查系统语音功能后重试');
    }
  }

  start(value: SystemSpeechInput): Promise<SystemSpeechResult> {
    const input = inputSchema.parse(value);
    if (this.closed) return Promise.reject(new Error('应用正在退出'));
    const existing = this.requests.get(input.requestId);
    if (existing) return existing.promise;
    for (const request of this.requests.values()) request.cancelled = true;
    const { promise, resolve, reject } = deferred<SystemSpeechResult>();
    const request: Request = { id: input.requestId, cancelled: false, promise, resolve, reject };
    this.requests.set(request.id, request);
    void this.transition(async () => {
      await this.cancelActive();
      if (request.cancelled || this.closed) this.finish(request, { text: '' });
      else this.recognize(request, input);
    }).catch((cause) => this.finish(request, undefined, cause));
    return promise;
  }

  stop(requestId: string) {
    return this.transition(async () => {
      const active = this.active;
      if (!active || active.request.id !== requestId || active.stopping) return;
      active.stopping = true;
      clearTimeout(active.timer);
      active.timer = setTimeout(() => {
        active.fail(new Error('系统识别未能结束，请重新开始'));
      }, this.launch.stopTimeoutMs ?? 5_000);
      active.child.stdin.write('stop\n');
    });
  }

  cancel(requestId: string) {
    const request = this.requests.get(requestId);
    if (request) request.cancelled = true;
    return this.transition(async () => {
      if (this.active?.request.id === requestId) await this.cancelActive();
    });
  }

  cancelAll() {
    for (const request of this.requests.values()) request.cancelled = true;
    return this.transition(() => this.cancelActive());
  }

  async close() {
    this.closed = true;
    await this.cancelAll();
  }

  private transition(operation: () => Promise<void>) {
    const pending = this.transitions.then(operation);
    this.transitions = pending.catch(() => {});
    return pending;
  }

  private arguments(mode: string, locale?: string) {
    return [
      ...(this.launch.args ?? []),
      mode,
      ...(locale ? ['--language', locale] : []),
      ...(mode === '--recognize' ? ['--max-duration-ms', String(maxVoiceRecordingMs)] : []),
    ];
  }

  private recognize(request: Request, input: SystemSpeechInput) {
    if (!this.launch.command) throw new Error('请使用桌面应用进行语音输入');
    if (this.launch.helperPath && !existsSync(this.launch.helperPath))
      throw new Error('系统语音组件尚未就绪，请更新 App');
    const child = spawn(this.launch.command, this.arguments('--recognize', input.language), {
      stdio: 'pipe',
      windowsHide: true,
    });
    let text: string | undefined;
    let failure: Error | undefined;
    const exited = deferred<void>();
    const active: Active = {
      request,
      child,
      closed: exited.promise,
      stopping: false,
      fail: (cause) => {
        failure = cause;
        void this.terminate(active);
      },
      timer: setTimeout(() => {
        active.fail(new Error('系统语音识别超时，请重新开始'));
      }, this.launch.timeoutMs ?? 120_000),
    };
    this.active = active;
    child.stderr.resume();
    child.stdin.on('error', () => active.fail(new Error('系统语音组件连接中断')));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line.length > 64 * 1024) {
        active.fail(new Error('系统语音结果过长'));
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event.type === 'result' && typeof event.text === 'string') text = event.text;
        else if (event.type === 'error' && typeof event.message === 'string')
          active.fail(new Error(speechError(event.message)));
        else if (event.type === 'cancelled') request.cancelled = true;
        else if (event.type !== 'ready' && event.type !== 'partial')
          throw new Error('系统语音组件返回格式错误');
      } catch {
        active.fail(new Error('系统语音组件返回格式错误'));
      }
    });
    child.once('error', () => {
      failure = new Error('无法启动系统语音组件');
    });
    child.once('close', (code) => {
      clearTimeout(active.timer);
      lines.close();
      if (this.active === active) this.active = undefined;
      exited.resolve();
      if (request.cancelled) this.finish(request, { text: '' });
      else if (failure) this.finish(request, undefined, failure);
      else if (code === 0 && text !== undefined) this.finish(request, { text });
      else this.finish(request, undefined, new Error('系统语音识别已结束，请重新开始'));
    });
  }

  private async cancelActive() {
    const active = this.active;
    if (!active) return;
    active.request.cancelled = true;
    await this.terminate(active);
  }

  private async terminate(active: Active) {
    active.child.kill();
    const force = setTimeout(() => active.child.kill('SIGKILL'), 1_500);
    await active.closed;
    clearTimeout(force);
  }

  private finish(request: Request, result?: SystemSpeechResult, cause?: unknown) {
    this.requests.delete(request.id);
    if (cause) request.reject(cause instanceof Error ? cause : new Error(String(cause)));
    else request.resolve(result ?? { text: '' });
  }
}

function speechError(message: string) {
  if (message.startsWith('SPEECH_LANGUAGE_MISSING'))
    return '系统尚未安装此语言的语音识别，请在系统语言设置中添加语音组件';
  if (message.startsWith('SYSTEM_SPEECH_UNAVAILABLE')) return '系统语音识别组件不可用';
  if (message.startsWith('SPEECH_MICROPHONE_UNAVAILABLE'))
    return '麦克风无法录音，请检查系统麦克风权限与输入设备';
  if (message.startsWith('SPEECH_PERMISSION_DENIED'))
    return '系统未允许麦克风访问，请在系统隐私设置中授权此应用';
  return message;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
