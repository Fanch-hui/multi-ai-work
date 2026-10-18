import type { RunContext } from '../../domain/provider.js';
import type { Usage } from '../../domain/types.js';
import { SupplementalInputError } from './request.js';
import { isRecoverableStreamError } from './request-errors.js';
import { ConfirmedToolStreamError } from './early-tools.js';
import { networkErrorCode } from '../network.js';
import { ModelRecoveryPendingError, type ModelRecovery } from '../../domain/recovery.js';

const transientStatuses = new Set([429, 502, 503, 504]);
const transientCodes = new Set(['server_is_overloaded', 'server_error', 'rate_limit_exceeded']);

export function modelErrorDetails(error: unknown): { status?: number; code?: string } {
  if (!error || typeof error !== 'object') return {};
  const source = error as { status?: unknown; code?: unknown; error?: { code?: unknown } };
  const code = source.code ?? source.error?.code ?? networkErrorCode(error);
  return {
    ...(Number.isSafeInteger(source.status) ? { status: source.status as number } : {}),
    ...(typeof code === 'string' && /^[a-zA-Z0-9_]+$/.test(code) ? { code } : {}),
  };
}

export function isTransientModelError(error: unknown): boolean {
  const { status, code } = modelErrorDetails(error);
  return transientStatuses.has(status ?? 0) || transientCodes.has(code ?? '');
}

export function markPartialOutput(error: unknown, partialOutput: boolean): unknown {
  return partialOutput && error instanceof Error ? Object.assign(error, { partialOutput: true }) : error;
}

function waitForRetry(delayMs: number, context: RunContext): Promise<void> {
  const { signal } = context;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); unsubscribe?.(); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const onInput = () => {
      if (!context.userInput?.hasPending() || context.isWaitingForInput?.() || context.inputSignal?.aborted) return;
      cleanup(); reject(new SupplementalInputError());
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    unsubscribe = context.userInput?.subscribe(onInput);
    signal.addEventListener('abort', onAbort, { once: true });
    onInput();
  });
}

export async function requestWithRetry<T extends { usage?: Usage }>(context: RunContext, request: (attempt: number, requestId: string) => Promise<T>, nextStep: () => number,
  recordDuration: (durationMs: number) => void, delays: readonly number[] = [2000, 5000, 10000, 20000, 30000],
  onRetry?: (recovery: ModelRecovery) => void | Promise<void>, initialAttempt = 0,
  prepare?: (attempt: number) => void | Promise<void>): Promise<T> {
  if (initialAttempt > Math.min(delays.length, 5)) throw new Error('模型连接自动恢复次数已耗尽，请继续原任务');
  for (let attempt = initialAttempt; ; attempt++) {
    context.signal.throwIfAborted();
    await prepare?.(attempt);
    context.signal.throwIfAborted();
    const step = nextStep();
    const requestId = `${context.runId}:${step}`;
    context.emit({ type: 'status', data: { phase: 'model-request', step, requestId } });
    const started = Date.now();
    try {
      const result = await request(attempt, requestId);
      const durationMs = Date.now() - started;
      recordDuration(durationMs);
      context.emit({ type: 'status', data: { phase: 'model-response', step, requestId, durationMs,
        ...(result.usage ? { usage: result.usage } : {}) } });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      recordDuration(durationMs);
      if (error instanceof SupplementalInputError) {
        context.emit({ type: 'status', data: { phase: 'model-input', step, requestId, durationMs } });
        throw error;
      }
      context.emit({ type: 'status', data: { phase: 'model-error', step, requestId, durationMs, ...modelErrorDetails(error instanceof ConfirmedToolStreamError ? error.streamError : error) } });
      context.signal.throwIfAborted();
      if (error instanceof ConfirmedToolStreamError) throw error;
      if (attempt >= Math.min(delays.length, 5) || !(isTransientModelError(error) || isRecoverableStreamError(error))) throw error;
      const delayMs = delays[attempt];
      const details = modelErrorDetails(error);
      const recovery: ModelRecovery = { attempt: attempt + 1, maxAttempts: 5, nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
        reason: `模型连接中断，等待自动恢复${details.code ? `（${details.code}）` : ''}` };
      await onRetry?.(recovery);
      context.signal.throwIfAborted();
      context.emit({ type: 'status', data: { phase: 'model-retry', step, requestId, ...recovery, delayMs, ...details } });
      if (context.userInput?.hasPending() && !context.isWaitingForInput?.() && !context.inputSignal?.aborted) throw new SupplementalInputError();
      if (context.deferRecovery && delayMs >= 10_000) throw new ModelRecoveryPendingError(recovery);
      await waitForRetry(delayMs, context);
    }
  }
}
