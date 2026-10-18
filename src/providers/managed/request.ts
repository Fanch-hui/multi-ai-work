import type { RunContext } from '../../domain/provider.js';
import type { ModelActivityKind } from '../../domain/task-activity.js';
import { ModelActivity } from '../activity.js';
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
  private modelActivity: ModelActivity;
  private completed = false;
  private readonly began = performance.now();
  private firstEvent = false;
  private firstOutput = false;
  private readyCalls = new Set<string>();

  constructor(private context: Pick<RunContext, 'signal' | 'emit' | 'userInput' | 'isWaitingForInput' | 'inputSignal'>,
    private readonly requestId?: string) {
    this.modelActivity = new ModelActivity(event => context.emit(event));
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.unsubscribe = context.userInput?.subscribe(() => {
      if (!this.outputStarted && context.userInput?.hasPending()
        && !context.isWaitingForInput?.() && !context.inputSignal?.aborted)
        this.controller.abort(new SupplementalInputError());
    });
    this.arm();
  }

  activity(kind: string, hasOutput: boolean, activityKind?: ModelActivityKind) {
    if (!this.firstEvent) { this.firstEvent = true; this.timing('model-first-event'); }
    if (hasOutput && !this.firstOutput) { this.firstOutput = true; this.timing('model-first-output'); }
    this.outputStarted ||= hasOutput;
    if (this.completed) return;
    this.arm();
    if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(kind)) return;
    if (activityKind) this.modelActivity.report(activityKind, kind);
  }

  error(error: unknown) { return this.signal.aborted ? this.signal.reason : error; }

  toolReady(name: string, callId: string) {
    if (this.readyCalls.has(callId)) return;
    this.readyCalls.add(callId);
    this.timing('tool-ready', { name, callId });
  }

  complete() {
    if (this.completed) return;
    this.completed = true;
    this.modelActivity.report('finishing', 'chat.completed');
    this.arm();
  }

  close() {
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.controller.abort();
  }

  private timing(stage: string, details: Record<string, unknown> = {}) {
    this.context.emit({ type: 'status', data: { phase: 'performance', stage,
      ...(this.requestId ? { requestId: this.requestId } : {}), durationMs: performance.now() - this.began, ...details } });
  }

  private arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(this.completed ? new CompletedStreamTailError()
      : new InactiveModelStreamError('模型响应连续 5 分钟没有活动，连接已停止，请重试')), this.completed ? 1000 : 300_000);
  }
}
