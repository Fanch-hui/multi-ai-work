import type { Storage } from './storage.js';

interface PendingRow {
  id: string;
  source_rowid?: number;
  payload?: string;
  conversation_id?: string;
}

const schema = `
  CREATE VIRTUAL TABLE IF NOT EXISTS chief_history_search USING fts5(
    message_id UNINDEXED, content, tokenize='trigram');
  CREATE TABLE IF NOT EXISTS chief_history_pending (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS chief_history_indexed (id TEXT PRIMARY KEY, source_rowid INTEGER);
  CREATE TABLE IF NOT EXISTS chief_history_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  DROP TRIGGER IF EXISTS chief_history_insert;
  DROP TRIGGER IF EXISTS chief_history_update;
  DROP TRIGGER IF EXISTS chief_history_conversation;
  CREATE TRIGGER IF NOT EXISTS chief_history_insert AFTER INSERT ON messages BEGIN
    INSERT INTO chief_history_pending(id) VALUES(new.id) ON CONFLICT(id) DO NOTHING;
  END;
  CREATE TRIGGER IF NOT EXISTS chief_history_update AFTER UPDATE OF payload ON messages BEGIN
    INSERT INTO chief_history_pending(id) VALUES(new.id) ON CONFLICT(id) DO NOTHING;
  END;
  CREATE TRIGGER IF NOT EXISTS chief_history_delete AFTER DELETE ON messages BEGIN
    DELETE FROM chief_history_search WHERE rowid=old.rowid;
    DELETE FROM chief_history_pending WHERE id=old.id;
    DELETE FROM chief_history_indexed WHERE id=old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS chief_history_conversation AFTER UPDATE OF payload ON conversations
  BEGIN
    INSERT INTO chief_history_pending(id)
      SELECT id FROM messages WHERE conversation_id=new.id ON CONFLICT(id) DO NOTHING;
  END;
`;

export class ChiefHistoryIndex {
  constructor(private storage: Storage) {
    const existing = storage
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('chief_history_search','chief_history_indexed')",
      )
      .all();
    storage.db.exec(schema);
    if (existing.length !== 2) this.rebuild();
  }

  rebuild() {
    this.storage.db.transaction(() => {
      this.storage.db.exec(`DELETE FROM chief_history_search;
        DELETE FROM chief_history_pending;
        DELETE FROM chief_history_indexed;
        DELETE FROM chief_history_meta;`);
    })();
  }

  sync(conversationIds: ReadonlySet<string>, limit = 200): boolean {
    const size = Math.max(1, Math.min(1000, Math.floor(limit)));
    return this.storage.db.transaction(() => {
      this.enqueueInitial(size);
      const rows = this.storage
        .prepare(`SELECT p.id, m.rowid AS source_rowid, m.payload, m.conversation_id
        FROM chief_history_pending p LEFT JOIN messages m ON m.id=p.id
          AND m.conversation_id IN (SELECT value FROM json_each(?))
        ORDER BY p.rowid LIMIT ?`)
        .all(JSON.stringify([...conversationIds]), size) as PendingRow[];
      const remove = this.storage.prepare(`DELETE FROM chief_history_search WHERE rowid=(
        SELECT source_rowid FROM chief_history_indexed WHERE id=?)`);
      const insert = this.storage.prepare(
        'INSERT INTO chief_history_search(rowid, message_id, content) VALUES(?,?,?)',
      );
      for (const row of rows) {
        remove.run(row.id);
        if (row.payload && conversationIds.has(row.conversation_id!)) {
          const message = JSON.parse(row.payload) as { status: string; content: string };
          if (message.status === 'committed' && message.content.trim())
            insert.run(row.source_rowid, row.id, message.content);
        }
        this.storage
          .prepare('INSERT OR REPLACE INTO chief_history_indexed(id,source_rowid) VALUES(?,?)')
          .run(row.id, row.source_rowid ?? null);
        this.storage.prepare('DELETE FROM chief_history_pending WHERE id=?').run(row.id);
      }
      return this.pending();
    })();
  }

  pending(): boolean {
    const seeded = this.storage
      .prepare("SELECT value FROM chief_history_meta WHERE key='seeded'")
      .get() as { value: number } | undefined;
    return !seeded || !!this.storage.prepare('SELECT 1 FROM chief_history_pending LIMIT 1').get();
  }

  private enqueueInitial(limit: number) {
    const seeded = this.storage
      .prepare("SELECT value FROM chief_history_meta WHERE key='seeded'")
      .get();
    if (seeded) return;
    const cursor = this.storage
      .prepare("SELECT value FROM chief_history_meta WHERE key='cursor'")
      .get() as { value: number } | undefined;
    const rows = this.storage
      .prepare('SELECT rowid, id FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?')
      .all(cursor?.value ?? 0, limit) as { rowid: number; id: string }[];
    for (const row of rows)
      this.storage.prepare('INSERT OR IGNORE INTO chief_history_pending(id) VALUES(?)').run(row.id);
    this.storage
      .prepare("INSERT OR REPLACE INTO chief_history_meta(key,value) VALUES('cursor',?)")
      .run(rows.at(-1)?.rowid ?? cursor?.value ?? 0);
    if (rows.length < limit)
      this.storage
        .prepare("INSERT OR REPLACE INTO chief_history_meta(key,value) VALUES('seeded',1)")
        .run();
  }
}
