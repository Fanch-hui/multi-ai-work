import type { RunContext } from '../../domain/provider.js';
import { CompletedStreamTailError, InactiveModelStreamError } from './request-errors.js';

export class SupplementalInputError extends Error {
  constructor() { super('接入新的用户消息'); }
}

export class ModelRequest {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private outputStarted = false;
  private lastActivity = 0;
  private completed = false;

  constructor(private context: RunContext) {
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.unsubscribe = context.userInput?.subscribe(() => {
      if (!this.outputStarted && context.userInput?.hasPending()
        && !context.isWaitingForInput?.() && !context.inputSignal?.aborted)
        this.controller.abort(new SupplementalInputError());
    });
    this.arm();
  }

  activity(kind: string, hasOutput: boolean) {
    this.outputStarted ||= hasOutput;
    this.arm();
    if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(kind)) return;
    const time = Date.now();
    if (time - this.lastActivity < 5000) return;
    this.lastActivity = time;
    this.context.emit({ type: 'status', data: { phase: 'model-activity', activity: kind } });
  }

  error(error: unknown) { return this.signal.aborted ? this.signal.reason : error; }

  complete() {
    if (this.completed) return;
    this.completed = true;
    this.arm();
  }

  close() {
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.controller.abort();
  }

  private arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(this.completed ? new CompletedStreamTailError()
      : new InactiveModelStreamError('模型响应连续 5 分钟没有活动，连接已停止，请重试')), this.completed ? 1000 : 300_000);
  }
}
