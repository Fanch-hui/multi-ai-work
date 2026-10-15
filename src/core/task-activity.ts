import type { TaskActivity } from '../domain/task-activity.js';
import type { Run, Task } from '../domain/types.js';
import type { Storage } from './storage.js';
import { terminal } from '../domain/task-status.js';

interface ActivityEvent {
  at: string; type: string; phase?: string; status?: string; name?: string;
  attempt?: number; maxAttempts?: number; nextAttemptAt?: string; code?: string;
}
const eventFields = (prefix = '') => `json_extract(${prefix}payload, '$.createdAt') AS at, json_extract(${prefix}payload, '$.type') AS type,
  json_extract(${prefix}payload, '$.data.phase') AS phase, json_extract(${prefix}payload, '$.data.status') AS status,
  json_extract(${prefix}payload, '$.data.name') AS name,
  json_extract(${prefix}payload, '$.data.attempt') AS attempt,
  json_extract(${prefix}payload, '$.data.maxAttempts') AS maxAttempts,
  json_extract(${prefix}payload, '$.data.nextAttemptAt') AS nextAttemptAt,
  json_extract(${prefix}payload, '$.data.code') AS code`;
const streamedText = `json_extract(payload, '$.type') = 'text' AND json_type(payload, '$.data.replace') IS NULL`;
const modelFilter = `(${streamedText}) OR
  (json_extract(payload, '$.type') = 'status' AND json_extract(payload, '$.data.phase') LIKE 'model-%'
    AND json_extract(payload, '$.data.phase') != 'model-retry')`;
const eventFilter = `(${streamedText}) OR json_extract(payload, '$.type') IN ('tool', 'status', 'compaction')`;

export function taskActivity(storage: Storage, task: Task): TaskActivity {
  const run = task.runIds.at(-1) ? storage.get<Run>('runs', task.runIds.at(-1)!) : undefined;
  const latest = (filter: string) => run && storage.prepare(`SELECT ${eventFields()} FROM run_events
    WHERE run_id = ? AND (${filter}) ORDER BY rowid DESC LIMIT 1`).get(run.id) as ActivityEvent | undefined;
  const model = latest(modelFilter);
  const tool = latest(`json_extract(payload, '$.type') = 'tool'`);
  const event = latest(eventFilter);
  const checkpoint = run && storage.prepare(`SELECT id FROM context_checkpoints
    WHERE json_extract(payload, '$.bindingId') = ? ORDER BY rowid DESC LIMIT 1`).get(run.bindingId) as { id: string } | undefined;
  return describeActivity(task, run, event, model?.at, tool?.at, checkpoint?.id);
}

export function taskActivityReader(storage: Storage, tasks: Task[], runs: Run[]): (task: Task) => TaskActivity {
  const runIds = new Set(tasks.map(task => task.runIds.at(-1)).filter(Boolean));
  const currentRuns = runs.filter(run => runIds.has(run.id)), runById = new Map(currentRuns.map(run => [run.id, run]));
  if (!currentRuns.length) return task => describeActivity(task);
  const rows = storage.prepare(`WITH latest AS MATERIALIZED (
    SELECT value AS run_id,
      (SELECT rowid FROM run_events WHERE run_id = requested.value AND (${modelFilter}) ORDER BY rowid DESC LIMIT 1) AS model_id,
      (SELECT rowid FROM run_events WHERE run_id = requested.value AND json_extract(payload, '$.type') = 'tool' ORDER BY rowid DESC LIMIT 1) AS tool_id,
      (SELECT rowid FROM run_events WHERE run_id = requested.value AND (${eventFilter}) ORDER BY rowid DESC LIMIT 1) AS event_id
    FROM json_each(?) AS requested
  ) SELECT latest.run_id AS runId, ${eventFields('event.')},
      json_extract(model.payload, '$.createdAt') AS modelAt, json_extract(tool.payload, '$.createdAt') AS toolAt
    FROM latest LEFT JOIN run_events AS event ON event.rowid = latest.event_id
      LEFT JOIN run_events AS model ON model.rowid = latest.model_id
      LEFT JOIN run_events AS tool ON tool.rowid = latest.tool_id`).all(JSON.stringify([...runIds])) as
        (ActivityEvent & { runId: string; modelAt?: string; toolAt?: string })[];
  const events = new Map(rows.map(row => [row.runId, row]));
  const checkpoints = storage.prepare(`SELECT id, json_extract(payload, '$.bindingId') AS bindingId
    FROM context_checkpoints WHERE rowid IN (
      SELECT MAX(rowid) FROM context_checkpoints
      WHERE json_extract(payload, '$.bindingId') IN (SELECT value FROM json_each(?))
      GROUP BY json_extract(payload, '$.bindingId'))`).all(JSON.stringify(currentRuns.map(run => run.bindingId))) as
        { id: string; bindingId: string }[];
  const checkpointIds = new Map(checkpoints.map(checkpoint => [checkpoint.bindingId, checkpoint.id]));
  return task => {
    const run = runById.get(task.runIds.at(-1) ?? ''), event = run && events.get(run.id);
    return describeActivity(task, run, event, event?.modelAt ?? undefined, event?.toolAt ?? undefined, run && checkpointIds.get(run.bindingId));
  };
}

function describeActivity(task: Task, run?: Run, event?: ActivityEvent, modelAt?: string, toolAt?: string, checkpointId?: string): TaskActivity {
  const activity = { lastActivityAt: event?.at ?? run?.createdAt, lastModelActivityAt: modelAt,
    lastToolActivityAt: toolAt, checkpointId };
  if (terminal(task.status)) return { ...activity, phase: 'finished' };
  if (task.status === 'recovering' && task.recovery)
    return { ...activity, phase: 'recovering', recovery: task.recovery, waitingFor: '模型连接恢复' };
  if (run?.cancelRequestedAt && ['running', 'waiting_approval'].includes(run.status))
    return { ...activity, phase: 'stopping', waitingFor: '模型请求和本任务进程退出' };
  const queueWaits: Record<string, string> = {
    dependencies: '前置任务完成', session_busy: '当前成员会话空闲', account_limit: '模型账号并发名额', global_limit: 'App 并发名额',
  };
  if (task.status === 'queued') return { ...activity, phase: 'queued', waitingFor: queueWaits[task.queueReason ?? ''] ?? '调度开始' };
  if (task.status === 'waiting_approval' || run?.status === 'waiting_approval') return { ...activity, phase: 'approval', waitingFor: '用户批准' };
  if (task.status === 'waiting_input') return { ...activity, phase: 'input', waitingFor: '用户回答' };
  if (task.status === 'waiting_children') return { ...activity, phase: 'children', waitingFor: '成员任务结束' };
  if (event?.phase === 'model-retry' && typeof event.attempt === 'number'
    && typeof event.maxAttempts === 'number' && typeof event.nextAttemptAt === 'string')
    return { ...activity, phase: 'recovering', waitingFor: '模型连接恢复', recovery: {
      attempt: event.attempt, maxAttempts: event.maxAttempts, nextAttemptAt: event.nextAttemptAt,
      ...(event.code ? { reason: event.code } : {}),
    } };
  if (event?.type === 'compaction' && event.status === 'started') return { ...activity, phase: 'compacting', waitingFor: '上下文整理' };
  if (event?.type === 'tool' && ['started', 'running'].includes(event.status ?? event.phase ?? ''))
    return { ...activity, phase: 'tool', toolName: event.name, waitingFor: event.name };
  if (event?.type === 'text') return { ...activity, phase: 'responding' };
  if (event?.phase?.startsWith('model-')) return { ...activity, phase: 'model', waitingFor: event.phase === 'model-retry' ? '模型服务重试' : '模型响应' };
  return { ...activity, phase: 'preparing' };
}
