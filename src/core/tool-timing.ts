import type { ProviderEvent } from '../domain/provider.js';

export class ToolTiming {
  private readonly began = performance.now();
  readonly startedAt = new Date().toISOString();
  readonly durations: Record<string, number> = {};
  status = 'failed';

  record(stage: string, durationMs: number) {
    this.durations[stage] = (this.durations[stage] ?? 0) + durationMs;
  }

  measure<T>(stage: string, action: () => T): T {
    const start = performance.now();
    try { return action(); } finally { this.record(stage, performance.now() - start); }
  }

  async measureAsync<T>(stage: string, action: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await action(); } finally { this.record(stage, performance.now() - start); }
  }

  finish(name: string, callId: string, emit: (event: ProviderEvent) => void) {
    if (this.durations.executionMs !== undefined) this.durations.executionMs = Math.max(0,
      this.durations.executionMs - (this.durations.networkQueueMs ?? 0) - (this.durations.approvalWaitMs ?? 0));
    emit({ type: 'status', data: { phase: 'performance', scope: 'tool', name, callId, status: this.status,
      startedAt: this.startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - this.began,
      durations: this.durations } });
  }
}
