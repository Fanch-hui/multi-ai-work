import type { Conversation, Run, RunEvent, Snapshot, Usage } from '../../../src/domain/types.js';

import { cacheStatistics, count, latestUsage, missingReason, nonnegative, rateStatistics, requestStatistics } from './conversation-statistics-samples.js';
export { nonnegative } from './conversation-statistics-samples.js';
const byTime = <T extends { createdAt: string }>(items: T[]) => [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

function aggregateUsage(runs: Run[], events: RunEvent[]) {
  const samples = runs.map(run => latestUsage(run, events));
  const known = samples.filter((usage): usage is Usage => !!usage && usage.source !== 'unknown'
    && (count(usage.inputTokens) || count(usage.outputTokens)));
  const inputs = known.filter(usage => count(usage.inputTokens));
  const outputs = known.filter(usage => count(usage.outputTokens));
  const input = inputs.reduce((total, usage) => total + usage.inputTokens!, 0);
  const output = outputs.reduce((total, usage) => total + usage.outputTokens!, 0);
  const completeRuns = runs.filter(run => run.metrics
    ? run.status === 'completed' && count(run.metrics.requests) && run.metrics.usageRequests === run.metrics.requests
      && run.metrics.usage?.source !== 'unknown' && count(run.metrics.usage?.inputTokens) && count(run.metrics.usage?.outputTokens)
    : run.status === 'completed' && run.usage?.source !== 'unknown' && count(run.usage?.inputTokens) && count(run.usage?.outputTokens)).length;
  const fullyReported = runs.length > 0 && completeRuns === runs.length;
  return { input: inputs.length ? input : undefined, output: outputs.length ? output : undefined,
    total: known.length ? input + output : undefined, ...cacheStatistics(runs, samples),
    complete: fullyReported, knownRuns: known.length, completeRuns, missingRuns: runs.length - completeRuns,
    estimated: known.some(usage => usage.source === 'estimated') };
}

function contextReading(events: RunEvent[], run?: Run) {
  const data = run?.contextUsage ?? (run ? events.filter(event => event.runId === run.id && event.type === 'context').at(-1)?.data : undefined);
  const source = data?.source === 'app-estimated' ? 'estimated' : data?.source === 'native-reported' ? 'reported' : 'unknown';
  const used = source === 'estimated' ? data?.estimatedTokens : data?.usedTokens;
  const window = data?.contextWindow;
  const direct = data?.usedPercentage ?? data?.percent;
  const percent = source === 'unknown' ? undefined : nonnegative(direct) ? direct
    : nonnegative(used) && nonnegative(window) && window > 0 ? used / window * 100 : undefined;
  return { source, percent, used: nonnegative(used) ? used : undefined, window: nonnegative(window) ? window : undefined,
    available: nonnegative(data?.availableTokens) ? data.availableTokens : undefined,
    outputReserve: nonnegative(data?.outputReserve) ? data.outputReserve : undefined };
}

export function conversationStatistics(data: Pick<Snapshot, 'tasks' | 'runs' | 'events'> & Partial<Pick<Snapshot, 'connections'>>, conversation: Conversation) {
  const tasks = data.tasks.filter(task => !['memory-review', 'question-decision'].includes(task.kind ?? '') && task.conversationId === conversation.id);
  const taskIds = new Set(tasks.map(task => task.id));
  const runs = byTime(data.runs.filter(run => taskIds.has(run.taskId)));
  const runIds = new Set(runs.map(run => run.id));
  const events = byTime(data.events.filter(event => runIds.has(event.runId)));
  const rootTasks = tasks.filter(task => !task.kind && (!task.parentId || !taskIds.has(task.parentId)));
  const turns = rootTasks.filter(task => runs.some(run => run.taskId === task.id)).length;
  const latestRun = runs.at(-1);
  return { turns, runs: runs.length, latestRun, ...requestStatistics(runs, events),
    usage: aggregateUsage(runs, events), context: contextReading(events, latestRun),
    missingReason: missingReason(latestRun, data.connections), ...rateStatistics(runs, data.connections) };
}
