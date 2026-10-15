import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Message, RunEvent, RunEventPage } from '../domain/types.js';
import { MessageStream } from './message-stream.js';

export const entityTables = ['connections', 'bots', 'conversations', 'workspaces', 'session_bindings',
  'tasks', 'runs', 'approvals', 'artifacts', 'memory_entries', 'context_checkpoints',
  'tool_connections', 'skills', 'tool_operations', 'deliveries', 'notifications', 'compactions', 'provider_archive', 'questions', 'processes', 'preset_installations', 'task_plans'] as const;
export type EntityTable = typeof entityTables[number];
const indexedFields = { status: '$.status', parentId: '$.parentId', runId: '$.runId', bindingId: '$.bindingId' } as const;

export class Storage {
  readonly db: Database.Database;
  readonly messageStream: MessageStream;
  private statements = new Map<string, Database.Statement>();
  private tableVersions = new Map<EntityTable, number>();
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.messageStream = new MessageStream(this);
    this.messageStream.recover();
  }

  prepare(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('数据库来自较新版本，请使用对应版本的 multi-AI work。');
    this.db.transaction(() => {
      for (const table of entityTables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          payload TEXT NOT NULL, UNIQUE(conversation_id, sequence));
        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_by_run ON run_events(run_id);
        CREATE INDEX IF NOT EXISTS text_by_message ON run_events(
          json_extract(payload, '$.data.messageId'), json_extract(payload, '$.data.streamSequence'))
          WHERE json_extract(payload, '$.data.streamSequence') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS archive_by_binding ON provider_archive(json_extract(payload, '$.bindingId'));
        CREATE INDEX IF NOT EXISTS checkpoints_by_binding ON context_checkpoints(json_extract(payload, '$.bindingId'));
        CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks(json_extract(payload, '$.status'));
        CREATE INDEX IF NOT EXISTS tasks_by_parent ON tasks(json_extract(payload, '$.parentId'));
        CREATE INDEX IF NOT EXISTS operations_by_run ON tool_operations(json_extract(payload, '$.runId'));
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, content, tokenize='trigram');
        PRAGMA user_version = 1;
      `);
      const columns = this.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'stream_sequence'))
        this.db.exec('ALTER TABLE messages ADD COLUMN stream_sequence INTEGER NOT NULL DEFAULT 0');
    })();
  }

  invalidateTables() {
    for (const table of entityTables) this.tableVersions.set(table, this.tableVersion(table) + 1);
  }

  tableVersion(table: EntityTable): number { return this.tableVersions.get(table) ?? 0; }

  all<T>(table: EntityTable): T[] {
    return (this.prepare(`SELECT payload FROM ${table}`).all() as { payload: string }[]).map(row => JSON.parse(row.payload) as T);
  }
  get<T>(table: EntityTable, id: string): T | undefined {
    const row = this.prepare(`SELECT payload FROM ${table} WHERE id = ?`).get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  byField<T>(table: EntityTable, field: keyof typeof indexedFields, value: string): T[] {
    const rows = this.prepare(`SELECT payload FROM ${table} WHERE json_extract(payload, '${indexedFields[field]}') = ? ORDER BY rowid`).all(value) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as T);
  }
  put<T extends { id: string }>(table: EntityTable, value: T): T {
    this.prepare(`INSERT INTO ${table}(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(value.id, JSON.stringify(value));
    this.tableVersions.set(table, this.tableVersion(table) + 1);
    if (table === 'memory_entries') {
      const memory = value as T & { content: string };
      this.prepare('DELETE FROM memory_search WHERE id = ?').run(value.id);
      this.prepare('INSERT INTO memory_search(id,content) VALUES (?,?)').run(value.id, memory.content);
    }
    return value;
  }
  delete(table: EntityTable, id: string) {
    this.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    this.tableVersions.set(table, this.tableVersion(table) + 1);
    if (table === 'memory_entries') this.prepare('DELETE FROM memory_search WHERE id = ?').run(id);
  }
  metadata<T>(key: string): T | undefined {
    const row = this.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  setMetadata(key: string, value: unknown) {
    this.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  messages(conversationId?: string): Message[] {
    const query = conversationId ? this.prepare('SELECT payload, stream_sequence FROM messages WHERE conversation_id = ? ORDER BY sequence') : this.prepare('SELECT payload, stream_sequence FROM messages ORDER BY conversation_id,sequence');
    const rows = (conversationId ? query.all(conversationId) : query.all()) as { payload: string; stream_sequence: number }[];
    return rows.map(row => this.messageStream.project(row).message);
  }
  getMessage(id: string): Message | undefined {
    const row = this.prepare('SELECT payload, stream_sequence FROM messages WHERE id = ?').get(id) as { payload: string; stream_sequence: number } | undefined;
    return row ? this.messageStream.project(row).message : undefined;
  }
  deleteMessage(id: string) { this.prepare('DELETE FROM messages WHERE id = ?').run(id); }
  appendMessage(message: Omit<Message, 'sequence'>): Message {
    return this.db.transaction(() => {
      const row = this.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM messages WHERE conversation_id = ?').get(message.conversationId) as { seq: number };
      const sequenceKey = `message-sequence:${message.conversationId}`;
      const value: Message = { ...message, sequence: Math.max(row.seq, this.metadata<number>(sequenceKey) ?? 0) + 1 };
      this.prepare('INSERT INTO messages(id,conversation_id,sequence,payload) VALUES (?,?,?,?)').run(value.id, value.conversationId, value.sequence, JSON.stringify(value));
      this.setMetadata(sequenceKey, value.sequence);
      return value;
    })();
  }
  updateMessage(message: Message) {
    this.messageStream.update(message);
  }
  event(event: RunEvent) {
    return this.prepare('INSERT OR IGNORE INTO run_events(id,run_id,payload) VALUES (?,?,?)').run(event.id, event.runId, JSON.stringify(event)).changes > 0;
  }
  runEvents(runId: string, cursor?: number, limit = 200): RunEventPage {
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.prepare(`SELECT rowid AS cursor, payload FROM run_events
      WHERE run_id = ? AND json_extract(payload, '$.type') != 'text' AND rowid < ?
      ORDER BY rowid DESC LIMIT ?`).all(runId, cursor ?? Number.MAX_SAFE_INTEGER, size + 1) as { cursor: number; payload: string }[];
    const page = rows.slice(0, size);
    return { events: page.map(row => JSON.parse(row.payload) as RunEvent).reverse(),
      nextCursor: rows.length > size ? page.at(-1)?.cursor : undefined };
  }
  events(): RunEvent[] {
    return (this.prepare('SELECT payload FROM run_events ORDER BY rowid DESC LIMIT 200').all() as { payload: string }[]).map(row => JSON.parse(row.payload) as RunEvent).reverse();
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  async backup(path: string) { await this.db.backup(path); }
  close() { this.statements.clear(); this.db.close(); }
}
