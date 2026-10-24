import type { ChiefHistorySearchInput } from '../domain/chief-history.js';
import type { Conversation, Task } from '../domain/types.js';
import type { Storage } from './storage.js';

export function searchChiefTaskMessages(
  storage: Storage,
  rooms: Conversation[],
  input: ChiefHistorySearchInput,
  limit: number,
): string[] {
  const terms = input.query?.trim().split(/\s+/).filter(Boolean).slice(0, 6) ?? [];
  if (!terms.length) return [];
  const ids = rooms.map((room) => room.id);
  const text =
    "(COALESCE(json_extract(payload,'$.goal'),'') || ' ' || COALESCE(json_extract(payload,'$.expectedOutput'),''))";
  const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  const rows = storage
    .prepare(`SELECT payload FROM tasks
    WHERE json_extract(payload,'$.conversationId') IN (SELECT value FROM json_each(?))
      AND json_extract(payload,'$.kind') IS NULL
      AND (${terms.map(() => `${text} LIKE ? ESCAPE '\\'`).join(' AND ')})
    ORDER BY json_extract(payload,'$.updatedAt') DESC LIMIT ?`)
    .all(JSON.stringify(ids), ...patterns, limit) as { payload: string }[];
  const found = rows.flatMap(({ payload }) => {
    const task = JSON.parse(payload) as Task;
    if (task.sourceMessageId) {
      const source = storage.getMessage(task.sourceMessageId);
      if (source?.status === 'committed' && source.conversationId === task.conversationId)
        return [source.id];
    }
    const message = storage
      .prepare(`SELECT id FROM messages WHERE conversation_id=?
      AND json_extract(payload,'$.status')='committed'
      AND json_extract(payload,'$.runId') IN (SELECT value FROM json_each(?))
      ORDER BY sequence DESC LIMIT 1`)
      .get(task.conversationId, JSON.stringify(task.runIds)) as { id: string } | undefined;
    return message ? [message.id] : [];
  });
  for (const room of rooms) {
    const title = room.name.toLocaleLowerCase();
    if (!terms.every((term) => title.includes(term.toLocaleLowerCase()))) continue;
    const row = storage
      .prepare(`SELECT id FROM messages WHERE conversation_id=?
      AND json_extract(payload,'$.status')='committed' ORDER BY sequence DESC LIMIT 1`)
      .get(room.id) as { id: string } | undefined;
    if (row) found.push(row.id);
    if (found.length >= limit) break;
  }
  return [...new Set(found)]
    .filter((id) => {
      const message = storage.getMessage(id)!;
      return (
        (!input.from || message.createdAt >= input.from) &&
        (!input.to || message.createdAt <= input.to)
      );
    })
    .slice(0, limit);
}
