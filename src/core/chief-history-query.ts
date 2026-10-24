import type { ChiefHistorySearchInput } from '../domain/chief-history.js';
import type { Storage } from './storage.js';

interface Query {
  where: string[];
  args: unknown[];
}
const content = "json_extract(m.payload, '$.content')";
const like = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

function conditions(conversationIds: string[], input: ChiefHistorySearchInput): Query {
  const where = [
    'm.conversation_id IN (SELECT value FROM json_each(?))',
    "json_extract(m.payload,'$.status')='committed'",
  ];
  const args: unknown[] = [JSON.stringify(conversationIds)];
  if (input.from) {
    where.push("json_extract(m.payload,'$.createdAt')>=?");
    args.push(input.from);
  }
  if (input.to) {
    where.push("json_extract(m.payload,'$.createdAt')<=?");
    args.push(input.to);
  }
  return { where, args };
}

export function searchChiefMessageIds(
  storage: Storage,
  conversationIds: string[],
  input: ChiefHistorySearchInput,
  limit: number,
): string[] {
  const terms = [...new Set(input.query?.trim().split(/\s+/).filter(Boolean) ?? [])].slice(0, 6);
  const base = conditions(conversationIds, input);
  if (!terms.length)
    return rows(
      storage,
      `SELECT m.id FROM messages m WHERE ${base.where.join(' AND ')}
      ORDER BY json_extract(m.payload,'$.createdAt') DESC, m.sequence DESC LIMIT ?`,
      [...base.args, limit],
    );
  const long = terms.filter((term) => [...term].length >= 3);
  const short = terms.filter((term) => [...term].length < 3);
  const where = [...base.where];
  const args = [...base.args];
  for (const term of short) {
    where.push(`${content} LIKE ? ESCAPE '\\'`);
    args.push(like(term));
  }
  const indexed: string[] = [];
  if (long.length) {
    const match = long.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
    indexed.push(
      ...rows(
        storage,
        `SELECT m.id FROM chief_history_search f
      JOIN messages m ON m.id=f.message_id
      WHERE chief_history_search MATCH ? AND ${where.join(' AND ')}
        AND NOT EXISTS(SELECT 1 FROM chief_history_pending p WHERE p.id=m.id)
      ORDER BY bm25(chief_history_search), json_extract(m.payload,'$.createdAt') DESC LIMIT ?`,
        [match, ...args, limit],
      ),
    );
  }
  if (!long.length) return plain(storage, base, terms, limit);
  const fresh = conditions(conversationIds, input);
  fresh.where.push(`(EXISTS(SELECT 1 FROM chief_history_pending p WHERE p.id=m.id)
    OR NOT EXISTS(SELECT 1 FROM chief_history_indexed i WHERE i.id=m.id))`);
  const unindexed = plain(storage, fresh, terms, limit);
  const found = [...new Set([...indexed, ...unindexed])];
  if (found.length || terms.length === 1) return found.slice(0, limit);
  return plain(storage, base, terms, limit, true);
}

function plain(storage: Storage, base: Query, terms: string[], limit: number, any = false) {
  const filter = terms.map(() => `${content} LIKE ? ESCAPE '\\'`).join(any ? ' OR ' : ' AND ');
  return rows(
    storage,
    `SELECT m.id FROM messages m WHERE ${base.where.join(' AND ')} AND (${filter})
    ORDER BY json_extract(m.payload,'$.createdAt') DESC, m.sequence DESC LIMIT ?`,
    [...base.args, ...terms.map(like), limit],
  );
}

function rows(storage: Storage, sql: string, args: unknown[]): string[] {
  return (storage.prepare(sql).all(...args) as { id: string }[]).map((row) => row.id);
}
