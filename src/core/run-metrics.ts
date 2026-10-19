import type { Run, RunEvent, RunMetrics, Usage } from '../domain/types.js';
import type { Storage } from './storage.js';
import { addUsage } from '../domain/usage.js';

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const requestPhases = new Set([
  'model-request',
  'model-response',
  'model-error',
  'model-input',
  'model-retry',
]);
const modelTiming = (event: RunEvent) =>
  event.type === 'status' &&
  ['model-response', 'model-error', 'model-input'].includes(String(event.data.phase)) &&
  duration(event.data.durationMs);
const summary = (event: RunEvent) => event.data.scope === 'compaction';

export const emptyRunMetrics = (): RunMetrics => ({
  requests: 0,
  summaryRequests: 0,
  usageRequests: 0,
});

function usageSample(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data.source !== 'reported' && data.source !== 'estimated') return undefined;
  return {
    source: data.source,
    inputTokens: count(data.inputTokens) ? data.inputTokens : undefined,
    outputTokens: count(data.outputTokens) ? data.outputTokens : undefined,
    cachedInputTokens: count(data.cachedInputTokens) ? data.cachedInputTokens : undefined,
  };
}

function addSample(metrics: RunMetrics, event: RunEvent): RunMetrics {
  const usage = usageSample(event.data.usage);
  if (!usage) return metrics;
  const input = usage.inputTokens,
    output = usage.outputTokens,
    cached = usage.cachedInputTokens;
  const source =
    usage.source === 'estimated' || metrics.usage?.source === 'estimated'
      ? 'estimated'
      : 'reported';
  const result = {
    ...metrics,
    usageRequests: metrics.usageRequests + (count(input) && count(output) ? 1 : 0),
  };
  if (count(input) || count(output))
    result.usage = {
      source,
      inputTokens: count(input)
        ? (metrics.usage?.inputTokens ?? 0) + input
        : metrics.usage?.inputTokens,
      outputTokens: count(output)
        ? (metrics.usage?.outputTokens ?? 0) + output
        : metrics.usage?.outputTokens,
    };
  if (usage.source === 'reported' && count(input) && count(cached) && cached <= input)
    result.cache = {
      inputTokens: (metrics.cache?.inputTokens ?? 0) + input,
      cachedInputTokens: (metrics.cache?.cachedInputTokens ?? 0) + cached,
      requests: (metrics.cache?.requests ?? 0) + 1,
    };
  if (
    !summary(event) &&
    count(output) &&
    duration(event.data.durationMs) &&
    event.data.durationMs > 0
  )
    result.rate = {
      outputTokens: (metrics.rate?.outputTokens ?? 0) + output,
      durationMs: (metrics.rate?.durationMs ?? 0) + event.data.durationMs,
      requests: (metrics.rate?.requests ?? 0) + 1,
      source:
        usage.source === 'estimated' || metrics.rate?.source === 'estimated'
          ? 'estimated'
          : 'reported',
    };
  return result;
}

function applyEvent(run: Run, event: RunEvent): Run {
  const { data } = event;
  if (event.type === 'status' && data.phase === 'model-request' && count(data.step)) {
    if (typeof data.requestId !== 'string')
      return { ...run, modelRequestCount: Math.max(run.modelRequestCount ?? 0, data.step) };
    const previous = run.metrics ?? emptyRunMetrics();
    const metrics = {
      ...previous,
      requests: previous.requests + 1,
      summaryRequests: previous.summaryRequests + (summary(event) ? 1 : 0),
    };
    return { ...run, metrics, modelRequestCount: metrics.requests };
  }
  if (modelTiming(event)) {
    const metrics =
      data.phase === 'model-response' && typeof data.requestId === 'string'
        ? addSample(run.metrics ?? emptyRunMetrics(), event)
        : run.metrics;
    return {
      ...run,
      metrics,
      ...(!summary(event)
        ? { modelDurationMs: (run.modelDurationMs ?? 0) + (data.durationMs as number) }
        : {}),
    };
  }
  if (event.type === 'context') return { ...run, contextUsage: data };
  if (event.type !== 'usage' || data.phase === 'compaction') return run;
  const usage = usageSample(data);
  return usage && (count(usage.inputTokens) || count(usage.outputTokens))
    ? {
        ...run,
        confirmedUsage: data.scope === 'turn' ? addUsage(run.confirmedUsage, usage) : usage,
      }
    : run;
}

function requestEvent(event: RunEvent): RunEvent {
  if (event.type !== 'status' || !requestPhases.has(String(event.data.phase))) return event;
  let requestId: string | undefined;
  if (typeof event.data.requestId === 'string') {
    requestId = event.data.requestId;
  } else if (count(event.data.step)) {
    requestId = `${event.runId}:${event.data.step}`;
  }
  return requestId
    ? {
        ...event,
        id: `${event.runId}:request:${requestId}:${event.data.phase}`,
        data: { ...event.data, requestId },
      }
    : event;
}

export function recordRunEvent(storage: Storage, input: RunEvent) {
  const event = requestEvent(input);
  storage.transaction(() => {
    if (!storage.event(event)) return;
    const run = storage.get<Run>('runs', event.runId);
    if (!run) return;
    const updated = applyEvent(run, event);
    if (updated !== run) storage.put('runs', updated);
  });
}

export function migrateRunMetrics(storage: Storage) {
  if (storage.metadata('run-metrics-v3')) return;
  storage.transaction(() => {
    const query = storage.db.prepare(`SELECT payload FROM run_events
      WHERE run_id = ? AND json_extract(payload, '$.type') IN ('status', 'usage', 'context') ORDER BY rowid`);
    for (const run of storage.all<Run>('runs')) {
      const events = (query.all(run.id) as { payload: string }[]).map(
        (row) => JSON.parse(row.payload) as RunEvent,
      );
      const samples = events.some(
        (event) => event.type === 'status' && typeof event.data.requestId === 'string',
      );
      const turnSamples = events.some(
        (event) => event.type === 'usage' && event.data.scope === 'turn',
      );
      const initial = {
        ...run,
        ...(turnSamples ? { confirmedUsage: undefined } : {}),
        ...(events.some((event) => modelTiming(event) && !summary(event))
          ? { modelDurationMs: undefined }
          : {}),
        ...(samples ? { metrics: emptyRunMetrics(), modelRequestCount: undefined } : {}),
      };
      const seen = new Set<string>();
      const updated = events.reduce((current, event) => {
        const keyed = event.type === 'status' && typeof event.data.requestId === 'string';
        const key = keyed ? `${event.data.requestId}:${event.data.phase}` : event.id;
        if (seen.has(key)) return current;
        seen.add(key);
        return applyEvent(current, event);
      }, initial as Run);
      storage.put('runs', updated);
    }
    storage.setMetadata('run-metrics-v2', true);
    storage.setMetadata('run-metrics-v3', true);
  });
}
