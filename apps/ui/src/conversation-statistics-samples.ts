import type { Connection, Run, RunEvent, Usage } from '../../../src/domain/types.js';

export const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const count = (value: unknown): value is number =>
  nonnegative(value) && Number.isSafeInteger(value);
export const activeRun = (run?: Run) =>
  !!run && ['running', 'waiting_approval', 'waiting_input'].includes(run.status);

export function missingReason(run?: Run, connections: Connection[] = []) {
  if (!run) return '尚未运行';
  const provider = connections.find((connection) => connection.id === run.connectionId)?.provider;
  if (provider === 'antigravity') return 'agy 运行时未提供';
  if (provider === 'qoder') return 'Qoder 暂未采集';
  if (activeRun(run)) return '统计中';
  if (run.status === 'failed') return '运行失败，记录不完整';
  if (run.status === 'cancelled' || run.status === 'interrupted')
    return '运行已取消或中断，记录不完整';
  return run.metrics ? '未取得有效样本' : '历史未记录';
}

export function latestUsage(run: Run, events: RunEvent[]): Usage | undefined {
  if (run.metrics) return run.metrics.usage;
  if (run.usage && run.usage.source !== 'unknown') return run.usage;
  if (run.confirmedUsage) return run.confirmedUsage;
  const sample = events
    .filter(
      (event) =>
        event.runId === run.id && event.type === 'usage' && event.data.phase !== 'compaction',
    )
    .at(-1)?.data;
  if (!sample || !['reported', 'estimated'].includes(String(sample.source))) return undefined;
  return {
    source: sample.source as Usage['source'],
    inputTokens: count(sample.inputTokens) ? sample.inputTokens : undefined,
    outputTokens: count(sample.outputTokens) ? sample.outputTokens : undefined,
    cachedInputTokens: count(sample.cachedInputTokens) ? sample.cachedInputTokens : undefined,
  };
}

export function requestStatistics(runs: Run[], events: RunEvent[]) {
  let knownRequests = 0,
    knownRequestRuns = 0,
    unknownRequestRuns = 0,
    summaryRequests = 0,
    summaryUnknownRuns = 0;
  for (const run of runs) {
    const requests = run.metrics ? run.metrics.requests : run.modelRequestCount;
    if (count(requests)) {
      knownRequests += requests;
      knownRequestRuns++;
    } else {
      const steps = new Set(
        events
          .filter(
            (event) =>
              event.runId === run.id &&
              event.type === 'status' &&
              event.data.phase === 'model-request' &&
              count(event.data.step),
          )
          .map((event) => event.data.step),
      );
      knownRequests += steps.size;
      if (steps.size) knownRequestRuns++;
      unknownRequestRuns++;
    }
    if (
      run.metrics &&
      count(run.metrics.summaryRequests) &&
      count(requests) &&
      run.metrics.summaryRequests <= requests
    )
      summaryRequests += run.metrics.summaryRequests;
    else summaryUnknownRuns++;
  }
  return {
    knownRequests,
    unknownRequestRuns,
    summaryRequests,
    summaryUnknownRuns,
    summaryKnownRuns: runs.length - summaryUnknownRuns,
    requests: knownRequestRuns || !runs.length ? knownRequests : undefined,
    requestsComplete: unknownRequestRuns === 0 && summaryUnknownRuns === 0,
  };
}

export function cacheStatistics(runs: Run[], samples: (Usage | undefined)[]) {
  let cached = 0,
    cacheInput = 0,
    cacheRequests = 0,
    cacheTotalRequests = 0,
    cacheLegacyRuns = 0,
    cacheLegacyTotalRuns = 0;
  let complete = runs.length > 0;
  runs.forEach((run, index) => {
    if (run.metrics) {
      const metrics = run.metrics,
        sample = metrics.cache;
      if (count(metrics.requests)) cacheTotalRequests += metrics.requests;
      const valid =
        sample &&
        count(sample.requests) &&
        sample.requests > 0 &&
        count(metrics.requests) &&
        sample.requests <= metrics.requests &&
        count(sample.inputTokens) &&
        count(sample.cachedInputTokens) &&
        sample.cachedInputTokens <= sample.inputTokens;
      if (valid) {
        cacheRequests += sample.requests;
        cached += sample.cachedInputTokens;
        cacheInput += sample.inputTokens;
      }
      if (!valid ? metrics.requests !== 0 : sample.requests !== metrics.requests) complete = false;
      return;
    }
    cacheLegacyTotalRuns++;
    const sample = samples[index];
    if (
      sample?.source === 'reported' &&
      count(sample.inputTokens) &&
      count(sample.cachedInputTokens) &&
      sample.cachedInputTokens <= sample.inputTokens
    ) {
      cacheLegacyRuns++;
      cached += sample.cachedInputTokens;
      cacheInput += sample.inputTokens;
    } else complete = false;
    if (run.status !== 'completed' || !run.usage || run.usage.source === 'unknown')
      complete = false;
  });
  const known = cacheRequests + cacheLegacyRuns > 0;
  return {
    cached: known ? cached : undefined,
    cacheInput: known ? cacheInput : undefined,
    cachePercent: known && cacheInput > 0 ? (cached / cacheInput) * 100 : undefined,
    cacheRequests,
    cacheTotalRequests,
    cacheLegacyRuns,
    cacheLegacyTotalRuns,
    cacheComplete: complete,
  };
}

function rateSample(run: Run) {
  if (run.metrics) {
    const { rate, requests, summaryRequests } = run.metrics;
    if (
      !rate ||
      !count(requests) ||
      !count(summaryRequests) ||
      summaryRequests > requests ||
      !count(rate.requests) ||
      rate.requests === 0 ||
      rate.requests > requests - summaryRequests ||
      !count(rate.outputTokens) ||
      !nonnegative(rate.durationMs) ||
      rate.durationMs === 0 ||
      !['reported', 'estimated'].includes(rate.source)
    )
      return undefined;
    return {
      rate: rate.outputTokens / (rate.durationMs / 1000),
      rateEstimated: rate.source === 'estimated',
      modelDurationMs: rate.durationMs,
      rateRequests: rate.requests,
      ratePartial: rate.requests < requests - summaryRequests || run.status !== 'completed',
    };
  }
  const usage = run.inferenceUsage,
    duration = run.modelDurationMs;
  if (
    !usage ||
    !['reported', 'estimated'].includes(usage.source) ||
    !count(usage.outputTokens) ||
    !nonnegative(duration) ||
    duration === 0
  )
    return undefined;
  return {
    rate: usage.outputTokens / (duration / 1000),
    rateEstimated: usage.source === 'estimated',
    modelDurationMs: duration,
    rateRequests: undefined,
    ratePartial: run.status !== 'completed',
  };
}

export function rateStatistics(runs: Run[], connections?: Connection[]) {
  const latest = runs.at(-1);
  const rateMissingReason = missingReason(latest, connections);
  for (const run of [...runs].reverse()) {
    const sample = rateSample(run);
    if (sample)
      return { ...sample, rateRun: run, rateFromPrevious: run !== latest, rateMissingReason };
  }
  return {
    rate: undefined,
    rateEstimated: false,
    modelDurationMs: undefined,
    rateRequests: undefined,
    ratePartial: false,
    rateRun: undefined,
    rateFromPrevious: false,
    rateMissingReason,
  };
}
