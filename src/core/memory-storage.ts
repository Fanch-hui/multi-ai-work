import type { MemoryEntry, MemoryRevisionRecord, MemoryUsage } from '../domain/memory.js';
import { searchableMemoryText } from '../domain/memory.js';
import type { MemorySearchMatch, MemorySearchQuery, MemoryStore } from '../runtime/memory.js';
import type { Storage } from './storage.js';

export interface MemoryUsageRecord extends MemoryUsage {
  id: string;
  autoInjectedScopes?: string[];
}

const authorizedWhere = `
  json_extract(m.payload, '$.status') = 'approved'
  AND (
    (json_extract(m.payload, '$.scope') = 'team' AND json_extract(m.payload, '$.ownerId') = ?)
    OR (
      json_extract(m.payload, '$.scope') = 'shared'
      AND EXISTS (SELECT 1 FROM json_each(m.payload, '$.allowedConversationIds') WHERE value = ?)
    )
    OR (
      json_extract(m.payload, '$.scope') = 'bot'
      AND json_extract(m.payload, '$.ownerId') = ?
      AND EXISTS (SELECT 1 FROM json_each(m.payload, '$.allowedConversationIds') WHERE value = ?)
    )
  )
`;

export function indexMemorySearch(storage: Storage, entry: MemoryEntry) {
  storage.prepare('DELETE FROM memory_search WHERE id = ?').run(entry.id);
  if (entry.status === 'revoked' || entry.status === 'superseded') return;
  storage.prepare('INSERT INTO memory_search(id,content) VALUES (?,?)').run(entry.id, searchableMemoryText(entry));
}

export function rebuildMemorySearch(storage: Storage) {
  storage.db.transaction(() => {
    storage.db.exec('DELETE FROM memory_search');
    for (const entry of storage.all<MemoryEntry>('memory_entries')) {
      if (entry.status === 'revoked' || entry.status === 'superseded') continue;
      storage.prepare('INSERT INTO memory_search(id,content) VALUES (?,?)').run(entry.id, searchableMemoryText(entry));
    }
    storage.setMetadata('memory-search-v2', true);
  })();
}

export function searchAuthorizedMemories(storage: Storage, query: MemorySearchQuery): MemorySearchMatch[] {
  const authParams = [query.conversationId, query.conversationId, query.botId, query.conversationId];
  const ftsRanks = new Map<string, number>();

  if (query.ftsQuery) {
    try {
      const ftsSql = `
        SELECT m.id AS id, bm25(memory_search) AS rank
        FROM memory_search
        JOIN memory_entries m ON m.id = memory_search.id
        WHERE memory_search MATCH ? AND ${authorizedWhere}
      `;
      const ftsRows = storage.prepare(ftsSql).all(query.ftsQuery, ...authParams) as { id: string; rank: number }[];
      for (const row of ftsRows) ftsRanks.set(row.id, row.rank);
    } catch {
      // Fallback to parameterized substring matching if FTS query fails
    }
  }

  const whereParts = [authorizedWhere];
  const params: unknown[] = [...authParams];

  if (query.ids?.length) {
    whereParts.push(`m.id IN (${query.ids.map(() => '?').join(',')})`);
    params.push(...query.ids);
  }
  if (query.topic?.trim()) {
    whereParts.push(`lower(COALESCE(NULLIF(trim(json_extract(m.payload, '$.topic')), ''), CASE json_extract(m.payload, '$.scope') WHEN 'team' THEN '团队约定' WHEN 'shared' THEN '共享资料' ELSE '常用偏好' END)) = lower(?)`);
    params.push(query.topic.trim());
  }

  const shortTerms = (query.shortTerms ?? []).map(term => term.toLocaleLowerCase().trim()).filter(Boolean);
  const ftsIds = [...ftsRanks.keys()];

  if (query.requireMatch) {
    const matchClauses: string[] = [];
    if (ftsIds.length) {
      matchClauses.push(`m.id IN (${ftsIds.map(() => '?').join(',')})`);
      params.push(...ftsIds);
    }
    for (const term of shortTerms) {
      matchClauses.push(`INSTR(lower(COALESCE(s.content, json_extract(m.payload, '$.content'))), ?) > 0`);
      params.push(term);
    }
    if (!matchClauses.length) return [];
    whereParts.push(`(${matchClauses.join(' OR ')})`);
  }

  let scoreSql = '0';
  const scoreParams: unknown[] = [];
  if (shortTerms.length) {
    scoreSql = shortTerms
      .map(() => `(CASE WHEN INSTR(lower(COALESCE(s.content, json_extract(m.payload, '$.content'))), ?) > 0 THEN 3 ELSE 0 END)`)
      .join(' + ');
    scoreParams.push(...shortTerms);
  }

  const sql = `
    SELECT m.id AS id, m.payload AS payload, (${scoreSql}) AS shortScore
    FROM memory_entries m
    LEFT JOIN memory_search s ON s.id = m.id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY
      (CASE WHEN json_extract(m.payload, '$.pinned') = 1 THEN 1 ELSE 0 END) DESC,
      shortScore DESC,
      json_extract(m.payload, '$.updatedAt') DESC
  `;

  const rows = storage.prepare(sql).all(...scoreParams, ...params) as { id: string; payload: string; shortScore: number }[];
  const mapped = rows.map(row => ({
    entry: JSON.parse(row.payload) as MemoryEntry,
    ftsRank: ftsRanks.get(row.id),
    shortScore: row.shortScore,
  }));
  if (ftsRanks.size > 0) {
    mapped.sort((a, b) => {
      const pinDiff = Number(!!b.entry.pinned) - Number(!!a.entry.pinned);
      if (pinDiff !== 0) return pinDiff;
      const scoreA = a.shortScore + (a.ftsRank !== undefined ? 10 / (1 + Math.abs(a.ftsRank)) : 0);
      const scoreB = b.shortScore + (b.ftsRank !== undefined ? 10 / (1 + Math.abs(b.ftsRank)) : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.entry.updatedAt.localeCompare(a.entry.updatedAt);
    });
  }
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const sliced = query.limit !== undefined
    ? mapped.slice(offset, offset + Math.max(1, Math.floor(query.limit)))
    : (offset > 0 ? mapped.slice(offset) : mapped);
  return sliced.map(({ entry, ftsRank }) => ({ entry, ftsRank }));
}

export function recordMemoryUsage(storage: Storage, memoryIds: string[], kind: 'auto' | 'active', scopeKey?: string) {
  const uniqueIds = [...new Set(memoryIds)];
  if (!uniqueIds.length) return;
  const timestamp = new Date().toISOString();
  storage.transaction(() => {
    for (const memoryId of uniqueIds) {
      const current = storage.get<MemoryUsageRecord>('memory_usage', memoryId) ?? {
        id: memoryId,
        autoInjectedCount: 0,
        activeReadCount: 0,
        autoInjectedScopes: [],
      };
      if (kind === 'auto') {
        const scopes = current.autoInjectedScopes ?? [];
        if (scopeKey && scopes.includes(scopeKey)) continue;
        const nextScopes = scopeKey ? [...scopes.slice(-99), scopeKey] : scopes;
        storage.put('memory_usage', {
          ...current,
          autoInjectedCount: current.autoInjectedCount + 1,
          lastAutoInjectedAt: timestamp,
          lastRecalledAt: timestamp,
          autoInjectedScopes: nextScopes,
        });
      } else {
        storage.put('memory_usage', {
          ...current,
          activeReadCount: current.activeReadCount + 1,
          lastActiveReadAt: timestamp,
          lastRecalledAt: timestamp,
        });
      }
    }
  });
}

export function getMemoryUsage(storage: Storage, memoryId: string): MemoryUsage | undefined {
  const record = storage.get<MemoryUsageRecord>('memory_usage', memoryId);
  if (!record) return undefined;
  return {
    autoInjectedCount: record.autoInjectedCount,
    activeReadCount: record.activeReadCount,
    lastRecalledAt: record.lastRecalledAt,
    lastAutoInjectedAt: record.lastAutoInjectedAt,
    lastActiveReadAt: record.lastActiveReadAt,
  };
}

export function listMemoryRevisions(storage: Storage, memoryId: string): MemoryRevisionRecord[] {
  return storage.byField<MemoryRevisionRecord>('memory_revisions', 'memoryId', memoryId)
    .sort((a, b) => b.revision - a.revision);
}

export function createStorageMemoryStore(storage: Storage): MemoryStore {
  if (!storage.metadata('memory-search-v2')) rebuildMemorySearch(storage);
  return {
    list: () => storage.all<MemoryEntry>('memory_entries'),
    save: entry => { storage.put('memory_entries', entry); },
    search: query => searchAuthorizedMemories(storage, query),
    revisions: memoryId => listMemoryRevisions(storage, memoryId),
    saveRevision: record => { storage.put('memory_revisions', record); },
    usage: memoryId => getMemoryUsage(storage, memoryId),
    recordUsage: (memoryIds, kind, scopeKey) => recordMemoryUsage(storage, memoryIds, kind, scopeKey),
    canReadMessage: (messageId, conversationId) => {
      const message = storage.getMessage(messageId);
      return !!message && message.conversationId === conversationId;
    },
  };
}
