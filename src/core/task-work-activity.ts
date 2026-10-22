import type { TaskActivity, TaskOperation } from '../domain/task-activity.js';
import type { Run, Task } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import type { Storage } from './storage.js';
import { visibleEventFilter } from './storage-schema.js';

const firstOutputFilter = `COALESCE(json_extract(payload, '$.data.scope'), '') != 'compaction' AND (
  (json_extract(payload, '$.type') = 'status' AND json_extract(payload, '$.data.phase') = 'model-work-started') OR
  (json_extract(payload, '$.type') = 'text' AND json_type(payload, '$.data.replace') IS NULL
    AND length(trim(COALESCE(json_extract(payload, '$.data.delta'), ''))) > 0) OR
  (json_extract(payload, '$.type') = 'tool' AND length(trim(COALESCE(json_extract(payload, '$.data.name'), ''))) > 0))`;

interface RunWork {
  operations: TaskOperation[];
  operationCount: number;
  requestCount: number;
  operationOrdinals: Map<string, number>;
  compactionCount: number;
}

export function taskWorkActivityReader(storage: Storage, tasks: Task[], runs: Run[]) {
  const allRunIds = [...new Set(tasks.flatMap((task) => task.runIds))];
  const firstByRun = new Map<string, string>();
  const workByRun = new Map<string, RunWork>();
  if (allRunIds.length) {
    const first = storage
      .prepare(`SELECT requested.value AS runId,
      (SELECT json_extract(payload, '$.createdAt') FROM run_events
       WHERE run_id = requested.value AND (${firstOutputFilter}) ORDER BY rowid LIMIT 1) AS at
      FROM json_each(?) AS requested`)
      .all(JSON.stringify(allRunIds)) as { runId: string; at: string | null }[];
    for (const row of first) if (row.at) firstByRun.set(row.runId, row.at);
  }
  const active = new Set(
    tasks.filter((task) => !terminal(task.status)).map((task) => task.runIds.at(-1)),
  );
  const liveRuns = runs.filter(
    (run) => active.has(run.id) && !run.endedAt && !terminal(run.status),
  );
  if (liveRuns.length) readRunWork(storage, liveRuns, workByRun);
  return (task: Task, activity: TaskActivity): TaskActivity => {
    const firstModelOutputAt = task.runIds
      .map((id) => firstByRun.get(id))
      .filter((at): at is string => !!at)
      .sort()[0];
    const runId = task.runIds.at(-1);
    const work = runId && workByRun.get(runId);
    const operations = work ? work.operations : [];
    const operationCount = work ? work.operationCount : 0;
    const activeTool = operations[0];
    const toolPhase =
      activeTool && ['preparing', 'tool', 'model', 'responding'].includes(activity.phase);
    let ordinal = work ? work.requestCount : 0;
    if (work && activity.phase === 'compacting') ordinal = work.compactionCount;
    const activityKey = activeTool
      ? `${runId}:tool:${work ? (work.operationOrdinals.get(activeTool.callId) ?? 0) : 0}`
      : `${runId ?? task.id}:${activity.phase}:${ordinal}`;
    return {
      ...activity,
      ...(toolPhase
        ? {
            phase: 'tool',
            toolName: activeTool.name,
            waitingFor: undefined,
            modelActivity: undefined,
          }
        : {}),
      firstModelOutputAt,
      activityKey,
      operations,
      operationCount,
    };
  };
}

function readRunWork(storage: Storage, runs: Run[], result: Map<string, RunWork>) {
  const runIds = JSON.stringify(runs.map((run) => run.id));
  // Group the persisted lifecycle before bounding the projection, so an old running call
  // remains visible even when hundreds of other calls have since completed.
  const rows = storage
    .prepare(`WITH work_rows AS MATERIALIZED (
    SELECT rowid AS seq, run_id AS runId, json_extract(payload, '$.type') AS type,
      json_extract(payload, '$.data.phase') AS phase,
      json_extract(payload, '$.data.scope') AS scope,
      json_extract(payload, '$.data.callId') AS callId,
      json_extract(payload, '$.data.name') AS name,
      CASE WHEN json_type(payload, '$.data.summary') = 'text'
        THEN substr(json_extract(payload, '$.data.summary'), 1, 240) END AS summary,
      json_extract(payload, '$.createdAt') AS at,
      COALESCE(json_extract(payload, '$.data.status'), json_extract(payload, '$.data.phase')) AS status,
      json_extract(payload, '$.data.source') AS source
    FROM run_events INDEXED BY nontext_events_by_run WHERE run_id IN (SELECT value FROM json_each(?)) AND ${visibleEventFilter}
  ), counts AS MATERIALIZED (
    SELECT runId,
      SUM(CASE WHEN phase = 'model-request' AND COALESCE(scope, '') != 'compaction' THEN 1 ELSE 0 END) AS requestCount,
      SUM(CASE WHEN type = 'compaction' AND status = 'started' THEN 1 ELSE 0 END) AS compactionCount
    FROM work_rows GROUP BY runId
  ), tool_rows AS MATERIALIZED (
    SELECT * FROM work_rows WHERE type = 'tool' AND typeof(callId) = 'text'
  ), calls AS (
    SELECT runId, callId, MIN(at) AS startedAt,
      ROW_NUMBER() OVER (PARTITION BY runId ORDER BY MIN(seq)) AS ordinal,
      COALESCE(MAX(CASE WHEN source = 'app' AND status IN ('completed', 'failed') THEN seq END), MAX(seq)) AS latest
    FROM tool_rows GROUP BY runId, callId
  ), active AS (
    SELECT t.runId, t.callId, t.name, t.summary, calls.startedAt, calls.ordinal,
      COUNT(*) OVER (PARTITION BY t.runId) AS operationCount,
      ROW_NUMBER() OVER (PARTITION BY t.runId ORDER BY t.seq DESC) AS position
    FROM calls JOIN tool_rows t ON t.seq = calls.latest
    WHERE t.status IN ('started', 'running') AND length(t.name) > 0
  ) SELECT requested.value AS runId, active.callId, active.name, active.summary,
      active.startedAt, active.operationCount, active.ordinal,
      COALESCE(counts.requestCount, 0) AS requestCount,
      COALESCE(counts.compactionCount, 0) AS compactionCount
    FROM json_each(?) AS requested
      LEFT JOIN active ON active.runId = requested.value AND active.position <= 4
      LEFT JOIN counts ON counts.runId = requested.value
    ORDER BY active.position`)
    .all(runIds, runIds) as (TaskOperation & {
    operationCount: number | null;
    requestCount: number;
    compactionCount: number;
    ordinal: number;
  })[];
  for (const row of rows) {
    let work = result.get(row.runId);
    if (!work) {
      work = {
        operations: [],
        operationCount: row.operationCount ?? 0,
        requestCount: row.requestCount,
        compactionCount: row.compactionCount,
        operationOrdinals: new Map(),
      };
      result.set(row.runId, work);
    }
    if (row.callId) work.operationOrdinals.set(row.callId, row.ordinal);
    if (row.callId)
      work.operations.push({
        runId: row.runId,
        callId: row.callId,
        name: row.name,
        summary: row.summary ?? undefined,
        startedAt: row.startedAt,
      });
  }
}
