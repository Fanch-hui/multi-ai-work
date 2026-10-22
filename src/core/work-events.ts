import type { RunEvent, RunEventPage } from '../domain/types.js';
import type { Storage } from './storage.js';
import { visibleEventFilter } from './storage-schema.js';

const workPhases = [
  'model-retry',
  'model-recovery',
  'model-error',
  'waiting_input',
  'waiting_children',
  'waiting_approval',
  'recovering',
  'resumed',
  'interrupted',
  'stopping',
  'cancelled',
  'cancel-requested',
];
const fields = [
  'callId',
  'name',
  'summary',
  'status',
  'phase',
  'source',
  'commandStatus',
  'exitCode',
  'attempt',
  'maxAttempts',
  'nextAttemptAt',
  'trigger',
  'owner',
  'questionId',
  'approvalId',
];
const strings = fields
  .map((key) => {
    const value = `json_extract(payload, '$.data.${key}')`;
    const text = key === 'summary' ? `substr(${value}, 1, 240)` : value;
    return `'${key}', CASE WHEN typeof(${value}) = 'text' THEN ${text} WHEN typeof(${value}) IN ('integer', 'real') THEN ${value} ELSE NULL END`;
  })
  .join(', ');

/** The work projection never loads raw arguments, command output or provider payloads. */
export function workEvents(
  storage: Storage,
  runId: string,
  cursor?: number,
  limit = 50,
): RunEventPage {
  const rows = storage
    .prepare(`SELECT rowid AS cursor, id, run_id AS runId,
    json_extract(payload, '$.type') AS type,
    json_extract(payload, '$.createdAt') AS createdAt,
    json_object(${strings}) AS data
    FROM run_events INDEXED BY nontext_events_by_run WHERE run_id = ? AND ${visibleEventFilter} AND rowid < ? AND (
      json_extract(payload, '$.type') IN ('tool', 'compaction', 'approval') OR
      (json_extract(payload, '$.type') = 'status' AND
        COALESCE(json_extract(payload, '$.data.scope'), '') != 'compaction' AND
        json_extract(payload, '$.data.phase') IN (SELECT value FROM json_each(?))))
    ORDER BY rowid DESC LIMIT ?`)
    .all(runId, cursor ?? Number.MAX_SAFE_INTEGER, JSON.stringify(workPhases), limit + 1) as {
    cursor: number;
    id: string;
    runId: string;
    type: RunEvent['type'];
    createdAt: string;
    data: string;
  }[];
  const page = rows.slice(0, limit);
  return {
    events: page
      .map(({ cursor: _cursor, data, ...event }) => ({
        ...event,
        data: Object.fromEntries(
          Object.entries(JSON.parse(data)).filter(([, value]) => value !== null),
        ),
      }))
      .reverse(),
    nextCursor: rows.length > limit ? page.at(-1)?.cursor : undefined,
  };
}
