import type Database from 'better-sqlite3';

export const entityTables = [
  'connections',
  'bots',
  'conversations',
  'workspaces',
  'session_bindings',
  'tasks',
  'runs',
  'approvals',
  'artifacts',
  'memory_entries',
  'memory_revisions',
  'memory_usage',
  'context_checkpoints',
  'tool_connections',
  'skills',
  'tool_operations',
  'deliveries',
  'notifications',
  'compactions',
  'provider_archive',
  'managed_progress_deltas',
  'questions',
  'processes',
  'preset_installations',
  'task_plans',
] as const;
export type EntityTable = (typeof entityTables)[number];
export const visibleEventFilter = "(json_extract(payload, '$.type') != 'text') = 1";

export function migrateStorage(
  db: Database.Database,
  prepare: (sql: string) => Database.Statement,
) {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 1) throw new Error('数据库来自较新版本，请使用对应版本的 multi-AI work。');
  db.transaction(() => {
    for (const table of entityTables)
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
    db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          payload TEXT NOT NULL, UNIQUE(conversation_id, sequence));
        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_by_run ON run_events(run_id);
        CREATE INDEX IF NOT EXISTS visible_events_by_sequence ON run_events((json_extract(payload, '$.type') != 'text'))
          WHERE ${visibleEventFilter};
        CREATE INDEX IF NOT EXISTS text_by_message ON run_events(
          json_extract(payload, '$.data.messageId'), json_extract(payload, '$.data.streamSequence'))
          WHERE json_extract(payload, '$.data.streamSequence') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS archive_by_binding ON provider_archive(json_extract(payload, '$.bindingId'));
        CREATE INDEX IF NOT EXISTS progress_deltas_by_run ON managed_progress_deltas(json_extract(payload, '$.runId'));
        CREATE INDEX IF NOT EXISTS checkpoints_by_binding ON context_checkpoints(json_extract(payload, '$.bindingId'));
        CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(json_extract(payload, '$.status'));
        CREATE INDEX IF NOT EXISTS tasks_by_parent ON tasks(json_extract(payload, '$.parentId'));
        CREATE INDEX IF NOT EXISTS tasks_by_request ON tasks(json_extract(payload, '$.requestId'));
        CREATE INDEX IF NOT EXISTS tasks_by_conversation ON tasks(json_extract(payload, '$.conversationId'));
        CREATE INDEX IF NOT EXISTS runs_by_task ON runs(json_extract(payload, '$.taskId'));
        CREATE INDEX IF NOT EXISTS bindings_by_owner_generation ON session_bindings(
          json_extract(payload, '$.botId'), json_extract(payload, '$.conversationId'),
          json_extract(payload, '$.purpose'), json_extract(payload, '$.generation') DESC);
        CREATE INDEX IF NOT EXISTS questions_by_task ON questions(json_extract(payload, '$.taskId'));
        CREATE INDEX IF NOT EXISTS artifacts_by_conversation ON artifacts(json_extract(payload, '$.conversationId'));
        CREATE INDEX IF NOT EXISTS artifacts_by_task ON artifacts(json_extract(payload, '$.taskId'));
        CREATE INDEX IF NOT EXISTS memories_by_partition_hash ON memory_entries(
          json_extract(payload, '$.scope'), json_extract(payload, '$.ownerId'), json_extract(payload, '$.contentHash'))
          WHERE json_extract(payload, '$.status') IN ('approved', 'candidate');
        CREATE INDEX IF NOT EXISTS operations_by_run ON tool_operations(json_extract(payload, '$.runId'));
        CREATE INDEX IF NOT EXISTS revisions_by_memory ON memory_revisions(json_extract(payload, '$.memoryId'));
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, content, tokenize='trigram');
        PRAGMA user_version = 1;
      `);
    const columns = prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'stream_sequence'))
      db.exec('ALTER TABLE messages ADD COLUMN stream_sequence INTEGER NOT NULL DEFAULT 0');
  })();
}
