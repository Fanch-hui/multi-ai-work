import type { RunContext } from '../domain/provider.js';

const startedRuns = new WeakMap<RunContext['emit'], Set<string>>();

export function markModelWorkStarted(context: Pick<RunContext, 'runId' | 'emit'>): void {
  let runs = startedRuns.get(context.emit);
  if (!runs) {
    runs = new Set();
    startedRuns.set(context.emit, runs);
  }
  if (runs.has(context.runId)) return;
  runs.add(context.runId);
  context.emit({ type: 'status', data: { phase: 'model-work-started' } });
}

export function hasOutputText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
