import type { Message, RunEvent } from '../domain/types.js';
import type { Storage } from './storage.js';

interface MessageRow { payload: string; stream_sequence: number; }
interface Fragment { sequence: number; payload: string; }

// The cursor is stored beside the materialized message, never in the public message payload.
export class MessageStream {
  private readonly rowStmt;
  private readonly latestStmt;
  private readonly appendStateStmt;
  private readonly updateStmt;
  private readonly draftIdsStmt;
  private readonly appendTx: (event: RunEvent, messageId: string) => boolean;
  private readonly flushTx: (messageId: string) => void;
  private readonly updateTx: (message: Message) => void;
  private readonly recoverTx: (rows: { id: string }[]) => void;

  constructor(private storage: Storage) {
    this.rowStmt = this.storage.prepare('SELECT payload, stream_sequence FROM messages WHERE id = ?');
    this.latestStmt = this.storage.prepare(`SELECT json_extract(payload, '$.data.streamSequence') AS sequence FROM run_events
      WHERE json_extract(payload, '$.data.messageId') = ? AND json_extract(payload, '$.data.streamSequence') IS NOT NULL
      ORDER BY json_extract(payload, '$.data.streamSequence') DESC LIMIT 1`);
    this.appendStateStmt = this.storage.prepare(`SELECT
        json_extract(payload, '$.status') AS status,
        json_extract(payload, '$.runId') AS runId,
        CASE
          WHEN json_extract(payload, '$.status') = 'draft' AND json_extract(payload, '$.runId') = ?
          THEN COALESCE((
            SELECT json_extract(payload, '$.data.streamSequence')
            FROM run_events
            WHERE json_extract(payload, '$.data.messageId') = messages.id
              AND json_extract(payload, '$.data.streamSequence') IS NOT NULL
            ORDER BY json_extract(payload, '$.data.streamSequence') DESC
            LIMIT 1
          ), 0)
          ELSE 0
        END AS maxSeq
      FROM messages WHERE id = ?`);
    this.updateStmt = this.storage.prepare('UPDATE messages SET payload = ?, stream_sequence = ? WHERE id = ?');
    this.draftIdsStmt = this.storage.prepare(`SELECT id FROM messages WHERE json_extract(payload, '$.status') = 'draft'`);

    this.appendTx = this.storage.db.transaction((event: RunEvent, messageId: string) => {
      const target = this.appendStateStmt.get(event.runId, messageId) as
        { status: string; runId?: string; maxSeq: number } | undefined;
      if (!target || target.status !== 'draft' || target.runId !== event.runId) {
        this.storage.event(event);
        return false;
      }
      const sequence = Number(target.maxSeq ?? 0) + 1;
      this.storage.event({ ...event, data: { ...event.data, messageId, streamSequence: sequence } });
      return true;
    });

    this.flushTx = this.storage.db.transaction((messageId: string) => {
      const row = this.row(messageId);
      if (!row) return;
      const { message, sequence } = this.project(row);
      if (sequence === row.stream_sequence) return;
      this.updateStmt.run(JSON.stringify(message), sequence, messageId);
    });

    this.updateTx = this.storage.db.transaction((message: Message) => {
      // Callers supply the projected content or an explicit replacement. Consume the same log prefix atomically.
      const sequence = this.latest(message.id);
      this.updateStmt.run(JSON.stringify(message), sequence, message.id);
    });

    this.recoverTx = this.storage.db.transaction((rows: { id: string }[]) => {
      for (const row of rows) this.flush(row.id);
    });
  }

  private row(id: string): MessageRow | undefined {
    return this.rowStmt.get(id) as MessageRow | undefined;
  }

  private latest(id: string): number {
    const row = this.latestStmt.get(id) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  append(event: RunEvent, messageId: string): boolean {
    return this.appendTx(event, messageId);
  }

  project(row: MessageRow) { return projectStreamMessage(this.storage, row); }

  flush(messageId: string): void {
    this.flushTx(messageId);
  }

  update(message: Message): void {
    this.updateTx(message);
  }

  recover(): void {
    const rows = this.draftIdsStmt.all() as { id: string }[];
    this.recoverTx(rows);
  }
}

export class RunTextWriter {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: string;
  private failure?: Error;
  private closed = false;
  constructor(private storage: Storage, private failed: (error: Error) => void) {}

  append(event: RunEvent, messageId: string) {
    this.check();
    if (this.closed) return;
    if (this.pending && this.pending !== messageId) this.flush();
    if (typeof event.data.replace === 'string') this.flush();
    this.storage.messageStream.append(event, messageId);
    this.pending = messageId;
    if (!this.timer) this.timer = setTimeout(() => {
      try { this.flush(); }
      catch (error) {
        this.failure = error instanceof Error ? error : new Error('流式消息保存失败');
        this.failed(this.failure);
      }
    }, 120);
  }

  check() { if (this.failure) throw this.failure; }

  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    this.check();
    if (this.pending) this.storage.messageStream.flush(this.pending);
    this.pending = undefined;
  }

  close() {
    this.closed = true;
    this.flush();
  }
}

export function projectStreamMessage(storage: Pick<Storage, 'prepare'>, row: MessageRow): { message: Message; sequence: number } {
  const message = JSON.parse(row.payload) as Message;
  if (message.status !== 'draft') return { message, sequence: row.stream_sequence };
  const fragments = storage.prepare(`SELECT payload, json_extract(payload, '$.data.streamSequence') AS sequence FROM run_events
    WHERE json_extract(payload, '$.data.messageId') = ? AND json_extract(payload, '$.data.streamSequence') IS NOT NULL
      AND json_extract(payload, '$.data.streamSequence') > ?
    ORDER BY json_extract(payload, '$.data.streamSequence')`).all(message.id, row.stream_sequence) as Fragment[];
  let sequence = row.stream_sequence;
  for (const fragment of fragments) {
    const event = JSON.parse(fragment.payload) as RunEvent;
    if (event.runId !== message.runId) { sequence = fragment.sequence; continue; }
    if (typeof event.data.replace === 'string') message.content = event.data.replace;
    else if (typeof event.data.delta === 'string') message.content += event.data.delta;
    sequence = fragment.sequence;
  }
  return { message, sequence };
}

