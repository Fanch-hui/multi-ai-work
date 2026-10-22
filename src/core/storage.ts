import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MemoryEntry,
  Message,
  RunEvent,
  RunEventPage,
  SessionBinding,
} from '../domain/types.js';
import type { MessagePage } from '../domain/snapshot-sync.js';
import { StorageChangesBuffer } from './storage-changes.js';
import { MessageStream } from './message-stream.js';
import { indexMemorySearch } from './memory-storage.js';

import {
  entityTables,
  type EntityTable,
  migrateStorage,
  visibleEventFilter,
} from './storage-schema.js';
export { entityTables, type EntityTable } from './storage-schema.js';

const indexedFields = {
  status: '$.status',
  parentId: '$.parentId',
  runId: '$.runId',
  bindingId: '$.bindingId',
  memoryId: '$.memoryId',
  requestId: '$.requestId',
  taskId: '$.taskId',
  conversationId: '$.conversationId',
  planId: '$.planId',
} as const;

export class Storage {
  readonly db: Database.Database;
  readonly messageStream: MessageStream;
  readonly changes = new StorageChangesBuffer();
  private statements = new Map<string, Database.Statement>();
  private tableVersions = new Map<EntityTable, number>();
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    migrateStorage(this.db, (sql) => this.prepare(sql));
    this.messageStream = new MessageStream(this);
    this.messageStream.recover();
  }

  prepare(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  invalidateTables() {
    this.changes.reset(true);
    for (const table of entityTables) this.tableVersions.set(table, this.tableVersion(table) + 1);
  }

  tableVersion(table: EntityTable): number {
    return this.tableVersions.get(table) ?? 0;
  }

  all<T>(table: EntityTable): T[] {
    return (this.prepare(`SELECT payload FROM ${table}`).all() as { payload: string }[]).map(
      (row) => JSON.parse(row.payload) as T,
    );
  }
  get<T>(table: EntityTable, id: string): T | undefined {
    const row = this.prepare(`SELECT payload FROM ${table} WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  byField<T>(table: EntityTable, field: keyof typeof indexedFields, value: string): T[] {
    const rows = this.prepare(
      `SELECT payload FROM ${table} WHERE json_extract(payload, '${indexedFields[field]}') = ? ORDER BY rowid`,
    ).all(value) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as T);
  }
  firstByField<T>(
    table: EntityTable,
    field: keyof typeof indexedFields,
    value: string,
  ): T | undefined {
    const row = this.prepare(
      `SELECT payload FROM ${table} WHERE json_extract(payload, '${indexedFields[field]}') = ? ORDER BY rowid LIMIT 1`,
    ).get(value) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  countByField(table: EntityTable, field: keyof typeof indexedFields, value: string): number {
    const row = this.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE json_extract(payload, '${indexedFields[field]}') = ?`,
    ).get(value) as { count: number };
    return row.count;
  }
  latestBinding(
    botId: string,
    conversationId: string,
    purpose?: SessionBinding['purpose'],
  ): SessionBinding | undefined {
    const row = (
      purpose === undefined
        ? this.prepare(`SELECT payload FROM session_bindings
          WHERE json_extract(payload, '$.botId') = ? AND json_extract(payload, '$.conversationId') = ?
            AND json_extract(payload, '$.purpose') IS NULL
          ORDER BY json_extract(payload, '$.generation') DESC, rowid DESC LIMIT 1`).get(
            botId,
            conversationId,
          )
        : this.prepare(`SELECT payload FROM session_bindings
          WHERE json_extract(payload, '$.botId') = ? AND json_extract(payload, '$.conversationId') = ?
            AND json_extract(payload, '$.purpose') = ?
          ORDER BY json_extract(payload, '$.generation') DESC, rowid DESC LIMIT 1`).get(
            botId,
            conversationId,
            purpose,
          )
    ) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as SessionBinding) : undefined;
  }
  put<T extends { id: string }>(table: EntityTable, value: T): T {
    this.prepare(
      `INSERT INTO ${table}(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
    ).run(value.id, JSON.stringify(value));
    this.tableVersions.set(table, this.tableVersion(table) + 1);
    if (table !== 'memory_usage' && table !== 'managed_progress_deltas')
      this.changes.mark(table, value.id);
    if (table === 'memory_entries') indexMemorySearch(this, value as unknown as MemoryEntry);
    return value;
  }
  delete(table: EntityTable, id: string) {
    this.changes.reset();
    this.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    this.tableVersions.set(table, this.tableVersion(table) + 1);
    if (table === 'memory_entries') this.prepare('DELETE FROM memory_search WHERE id = ?').run(id);
  }
  metadata<T>(key: string): T | undefined {
    const row = this.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  setMetadata(key: string, value: unknown) {
    this.prepare(
      'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, JSON.stringify(value));
  }
  messages(conversationId?: string): Message[] {
    const query = conversationId
      ? this.prepare(
          'SELECT payload, stream_sequence FROM messages WHERE conversation_id = ? ORDER BY sequence',
        )
      : this.prepare(
          'SELECT payload, stream_sequence FROM messages ORDER BY conversation_id,sequence',
        );
    const rows = (conversationId ? query.all(conversationId) : query.all()) as {
      payload: string;
      stream_sequence: number;
    }[];
    return rows.map((row) => this.messageStream.project(row).message);
  }
  messagePage(conversationId: string, before = Number.MAX_SAFE_INTEGER, limit = 50): MessagePage {
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.prepare(`SELECT payload, stream_sequence FROM messages
      WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`).all(
      conversationId,
      before,
      size + 1,
    ) as { payload: string; stream_sequence: number }[];
    const messages = rows
      .slice(0, size)
      .map((row) => this.messageStream.project(row).message)
      .reverse();
    return { messages, ...(rows.length > size ? { nextBefore: messages[0]?.sequence } : {}) };
  }
  messageRange(conversationId: string, from: number): MessagePage {
    const rows = this.prepare(`SELECT payload, stream_sequence FROM messages
      WHERE conversation_id = ? AND sequence >= ? ORDER BY sequence`).all(conversationId, from) as {
      payload: string;
      stream_sequence: number;
    }[];
    const earlier = this.prepare(
      'SELECT 1 FROM messages WHERE conversation_id = ? AND sequence < ? LIMIT 1',
    ).get(conversationId, from);
    return {
      messages: rows.map((row) => this.messageStream.project(row).message),
      ...(earlier ? { nextBefore: from } : {}),
    };
  }
  getMessage(id: string): Message | undefined {
    const row = this.prepare('SELECT payload, stream_sequence FROM messages WHERE id = ?').get(
      id,
    ) as { payload: string; stream_sequence: number } | undefined;
    return row ? this.messageStream.project(row).message : undefined;
  }
  deleteMessage(id: string) {
    this.prepare('DELETE FROM messages WHERE id = ?').run(id);
    this.changes.reset();
  }
  appendMessage(message: Omit<Message, 'sequence'>): Message {
    return this.db.transaction(() => {
      const row = this.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS seq FROM messages WHERE conversation_id = ?',
      ).get(message.conversationId) as { seq: number };
      const sequenceKey = `message-sequence:${message.conversationId}`;
      const value: Message = {
        ...message,
        sequence: Math.max(row.seq, this.metadata<number>(sequenceKey) ?? 0) + 1,
      };
      this.prepare(
        'INSERT INTO messages(id,conversation_id,sequence,payload) VALUES (?,?,?,?)',
      ).run(value.id, value.conversationId, value.sequence, JSON.stringify(value));
      this.setMetadata(sequenceKey, value.sequence);
      this.changes.mark('messages', value.id);
      return value;
    })();
  }
  updateMessage(message: Message) {
    this.messageStream.update(message);
    this.changes.mark('messages', message.id);
  }
  event(event: RunEvent) {
    const inserted =
      this.prepare('INSERT OR IGNORE INTO run_events(id,run_id,payload) VALUES (?,?,?)').run(
        event.id,
        event.runId,
        JSON.stringify(event),
      ).changes > 0;
    if (!inserted) return false;
    this.changes.mark(event.type === 'text' ? 'text_events' : 'events', event.runId);
    if (typeof event.data.messageId === 'string')
      this.changes.mark('messages', event.data.messageId);
    return true;
  }
  runEvents(runId: string, cursor?: number, limit = 200): RunEventPage {
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.prepare(`SELECT rowid AS cursor, payload FROM run_events
      WHERE run_id = ? AND json_extract(payload, '$.type') != 'text' AND rowid < ?
      ORDER BY rowid DESC LIMIT ?`).all(runId, cursor ?? Number.MAX_SAFE_INTEGER, size + 1) as {
      cursor: number;
      payload: string;
    }[];
    const page = rows.slice(0, size);
    return {
      events: page.map((row) => JSON.parse(row.payload) as RunEvent).reverse(),
      nextCursor: rows.length > size ? page.at(-1)?.cursor : undefined,
    };
  }
  latestNonTextEventSequence(): number {
    const row = this.prepare(`SELECT COALESCE((SELECT rowid FROM run_events
      WHERE ${visibleEventFilter} ORDER BY rowid DESC LIMIT 1), 0) AS seq`).get() as {
      seq: number;
    };
    return row.seq;
  }
  eventsAfter(afterSequence: number, limit = 200): { events: RunEvent[]; eventSequence: number } {
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = this.prepare(`SELECT rowid, payload FROM run_events
      WHERE rowid > ? AND ${visibleEventFilter}
      ORDER BY rowid DESC LIMIT ?`).all(afterSequence, size) as {
      rowid: number;
      payload: string;
    }[];
    const eventSequence =
      rows[0]?.rowid ?? (afterSequence > 0 ? afterSequence : this.latestNonTextEventSequence());
    return {
      events: rows.map((row) => JSON.parse(row.payload) as RunEvent).reverse(),
      eventSequence,
    };
  }
  events(): RunEvent[] {
    return (
      this.prepare(`SELECT payload FROM run_events
      WHERE ${visibleEventFilter}
      ORDER BY rowid DESC LIMIT 200`).all() as { payload: string }[]
    )
      .map((row) => JSON.parse(row.payload) as RunEvent)
      .reverse();
  }
  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }
  async backup(path: string) {
    await this.db.backup(path);
  }
  close() {
    this.statements.clear();
    this.db.close();
  }
}
