import type { Run, RunEvent } from '../../../src/domain/types.js';

const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function runPerformance(run: Run, events: RunEvent[]) {
  const samples = events.filter(
    (event) =>
      event.runId === run.id && event.type === 'status' && event.data.phase === 'performance',
  );
  if (!samples.length) return undefined;
  const sum = (select: (data: Record<string, unknown>) => unknown) => {
    const values = samples.map((event) => select(event.data)).filter(valid);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const tool = (field: string) =>
    sum((data) =>
      data.scope === 'tool'
        ? (data.durations as Record<string, unknown> | undefined)?.[field]
        : undefined,
    );
  const stage = (name: string) =>
    sum((data) => (data.stage === name ? data.durationMs : undefined));
  const ready = new Map(
    samples
      .filter((event) => event.data.stage === 'tool-ready')
      .map((event) => [event.data.callId, Date.parse(event.createdAt)]),
  );
  const toolStartWaitMs = sum((data) => {
    if (data.scope !== 'tool' || typeof data.startedAt !== 'string') return undefined;
    const arrivedAt = ready.get(data.callId);
    return arrivedAt === undefined
      ? undefined
      : Math.max(0, Date.parse(data.startedAt) - arrivedAt);
  });
  const elapsed = run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.createdAt) : undefined;
  return {
    elapsedMs: valid(elapsed) ? elapsed : undefined,
    modelMs: run.modelDurationMs,
    firstEventMs: stage('model-first-event'),
    firstOutputMs: stage('model-first-output'),
    toolStartWaitMs,
    authorizationMs: tool('authorizationMs'),
    workspaceQueueMs: tool('workspaceQueueMs'),
    networkQueueMs: tool('networkQueueMs'),
    approvalWaitMs: tool('approvalWaitMs'),
    executionMs: tool('executionMs'),
    processingMs: tool('processingMs'),
    saveMs: tool('saveMs'),
    checkpointMs: stage('checkpoint-save'),
    earlyTailMs: stage('tool-early-wait'),
  };
}
