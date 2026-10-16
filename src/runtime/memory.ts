import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryEntry, MemoryRecallInput, MemoryRevisionRecord, MemorySelection, MemoryUsage,
} from '../domain/memory.js';
import { memorySummary, memoryTopic, normalizeMemoryContent } from '../domain/memory.js';
import {
  emptyMemorySelection, extractQueryTerms, formatMemorySelection,
  scoreMemoryEntry, selectMemoryContext, type MemorySelectOptions,
} from './memory-recall.js';

export interface MemorySearchMatch {
  entry: MemoryEntry;
  ftsRank?: number;
}

export interface MemorySearchQuery {
  botId: string;
  conversationId: string;
  ftsQuery?: string;
  shortTerms?: string[];
  topic?: string;
  ids?: string[];
  requireMatch?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryStore {
  list(): MemoryEntry[];
  save(entry: MemoryEntry): void;
  search?(query: MemorySearchQuery): MemorySearchMatch[];
  revisions?(memoryId: string): MemoryRevisionRecord[];
  saveRevision?(record: MemoryRevisionRecord): void;
  usage?(memoryId: string): MemoryUsage | undefined;
  recordUsage?(memoryIds: string[], kind: 'auto' | 'active', scopeKey?: string): void;
  canReadMessage?(messageId: string, conversationId: string): boolean;
}

export interface MemoryIdentity {
  botId: string;
  conversationId: string;
  memberIds?: string[];
  roleTerms?: string[];
}

export function isAuthorizedMemory(entry: MemoryEntry, identity: Pick<MemoryIdentity, 'botId' | 'conversationId'>): boolean {
  if (entry.status !== 'approved') return false;
  if (entry.scope === 'team') return entry.ownerId === identity.conversationId;
  if (entry.scope === 'shared') return entry.allowedConversationIds.includes(identity.conversationId);
  return entry.ownerId === identity.botId && entry.allowedConversationIds.includes(identity.conversationId);
}

export class MemoryService {
  private selectionCache = new Map<string, { fingerprint: string; selection: MemorySelection }>();
  constructor(private readonly store: MemoryStore) {}

  authorizedEntries(identity: Pick<MemoryIdentity, 'botId' | 'conversationId'>): Map<string, MemoryEntry> {
    const matches = this.store.search
      ? this.store.search({ botId: identity.botId, conversationId: identity.conversationId })
          .map(item => item.entry)
      : this.store.list();
    return new Map(
      matches
        .filter(entry => isAuthorizedMemory(entry, identity))
        .map(entry => [entry.id, entry]),
    );
  }

  recall(identity: MemoryIdentity, query: string, limit = 8, topic?: string): MemoryEntry[] {
    if (limit <= 0) return [];
    const trimmed = query.trim();
    const normalizedTopic = topic?.trim().toLocaleLowerCase();
    const terms = extractQueryTerms(trimmed);
    const hasQuery = terms.allTerms.length > 0;
    const candidates = this.store.search
      ? this.store.search({
          botId: identity.botId,
          conversationId: identity.conversationId,
          ftsQuery: terms.ftsQuery,
          shortTerms: terms.shortTerms,
          topic: topic?.trim(),
          requireMatch: hasQuery,
        })
      : this.store.list().map(entry => ({ entry, ftsRank: undefined }));

    return candidates
      .filter(item => isAuthorizedMemory(item.entry, identity))
      .filter(item => !normalizedTopic || memoryTopic(item.entry).toLocaleLowerCase() === normalizedTopic)
      .map(item => scoreMemoryEntry(item.entry, terms, {
        ftsRank: item.ftsRank,
        roleTerms: identity.roleTerms,
        usage: this.store.usage?.(item.entry.id),
      }))
      .filter(item => !hasQuery || item.relevanceScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, Math.max(0, limit))
      .map(item => this.sanitizeSourceIds(item.entry, identity.conversationId));
  }

  query(
    identity: MemoryIdentity,
    input: string | MemoryRecallInput,
    options?: { recordActiveRead?: boolean; scopeKey?: string },
  ): unknown {
    if (typeof input === 'string') {
      const entries = this.recall(identity, input);
      if (options?.recordActiveRead && entries.length) {
        this.store.recordUsage?.(entries.map(entry => entry.id), 'active', options.scopeKey);
      }
      return entries;
    }

    const limit = Math.max(1, Math.min(50, input.limit ?? 8));
    const offset = Math.max(0, input.offset ?? 0);
    const authorized = this.authorizedEntries(identity);
    let matched: MemoryEntry[];

    if (input.ids?.length) {
      const requested = new Set(input.ids);
      matched = [...authorized.values()]
        .filter(entry => requested.has(entry.id))
        .map(entry => this.sanitizeSourceIds(entry, identity.conversationId));
    } else if (input.query?.trim()) {
      matched = this.recall(identity, input.query, Number.MAX_SAFE_INTEGER, input.topic);
    } else {
      const all = [...authorized.values()]
        .filter(entry => !input.topic?.trim() || memoryTopic(entry).toLocaleLowerCase() === input.topic.trim().toLocaleLowerCase())
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
      matched = all.map(entry => this.sanitizeSourceIds(entry, identity.conversationId));
    }

    const page = matched.slice(offset, offset + limit);
    if (options?.recordActiveRead && page.length) {
      this.store.recordUsage?.(page.map(entry => entry.id), 'active', options.scopeKey);
    }

    if (input.offset === undefined && !input.includeHistory) {
      return page;
    }

    const history = input.includeHistory ? this.buildAuthorizedHistory(page, identity) : undefined;
    return {
      entries: page,
      total: matched.length,
      offset,
      nextOffset: offset + limit < matched.length ? offset + limit : null,
      ...(history ? { history } : {}),
    };
  }

  selectContext(identity: MemoryIdentity, options: MemorySelectOptions & { cacheKey?: string; recordAutoInject?: boolean; scopeKey?: string } = {}): MemorySelection {
    const terms = extractQueryTerms(options.query ?? '');
    const ftsRanks = new Map<string, number>();
    let authorizedList: MemoryEntry[];

    if (this.store.search) {
      const allMatches = this.store.search({
        botId: identity.botId,
        conversationId: identity.conversationId,
        ftsQuery: terms.ftsQuery,
        shortTerms: terms.shortTerms,
        requireMatch: false,
      });
      authorizedList = [];
      for (const match of allMatches) {
        if (!isAuthorizedMemory(match.entry, identity)) continue;
        authorizedList.push(this.sanitizeSourceIds(match.entry, identity.conversationId));
        if (match.ftsRank !== undefined) ftsRanks.set(match.entry.id, match.ftsRank);
      }
    } else {
      authorizedList = this.store.list()
        .filter(entry => isAuthorizedMemory(entry, identity))
        .map(entry => this.sanitizeSourceIds(entry, identity.conversationId));
    }

    if (!authorizedList.length) return emptyMemorySelection(options.budgetTokens);

    const semanticSig = authorizedList
      .map(entry => `${entry.id}@${entry.revision}:${entry.pinned ? 1 : 0}:${entry.topic ?? ''}:${entry.summary ?? ''}`)
      .sort()
      .join('|');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      semanticSig,
      query: options.query?.trim() ?? '',
      roleTerms: identity.roleTerms ?? options.roleTerms ?? [],
      budgetTokens: options.budgetTokens ?? 2000,
    })).digest('hex');

    if (options.cacheKey) {
      const cached = this.selectionCache.get(options.cacheKey);
      if (cached && cached.fingerprint === fingerprint) {
        if (options.recordAutoInject && cached.selection.fullEntries.length) {
          this.store.recordUsage?.(cached.selection.fullEntries.map(entry => entry.id), 'auto', options.scopeKey ?? options.cacheKey);
        }
        return cached.selection;
      }
    }

    const usageById = new Map<string, MemoryUsage>();
    if (this.store.usage) {
      for (const entry of authorizedList) {
        const usage = this.store.usage(entry.id);
        if (usage) usageById.set(entry.id, usage);
      }
    }

    const selection = selectMemoryContext(authorizedList, {
      ...options,
      roleTerms: identity.roleTerms ?? options.roleTerms,
      ftsRanks,
      usageById,
    });

    if (options.cacheKey) {
      this.selectionCache.set(options.cacheKey, { fingerprint, selection });
      if (this.selectionCache.size > 256) {
        const oldest = this.selectionCache.keys().next().value;
        if (oldest) this.selectionCache.delete(oldest);
      }
    }
    if (options.recordAutoInject && selection.fullEntries.length) {
      this.store.recordUsage?.(selection.fullEntries.map(entry => entry.id), 'auto', options.scopeKey ?? options.cacheKey);
    }
    return selection;
  }

  compatibilityDigest(botId: string, conversationId: string): string {
    const entries = [...this.authorizedEntries({ botId, conversationId }).values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    if (!entries.length) return '';
    return `长期记忆（背景资料）：\n${entries.map(entry => `[${entry.id}@${entry.revision}] ${entry.content}`).join('\n')}`;
  }

  instructions(botId: string, conversationId: string, options?: MemorySelectOptions & { roleTerms?: string[]; cacheKey?: string; recordAutoInject?: boolean; scopeKey?: string }): string {
    const selection = this.selectContext({ botId, conversationId, roleTerms: options?.roleTerms }, options);
    return formatMemorySelection(selection);
  }

  propose(input: MemoryIdentity & {
    scope: MemoryEntry['scope'];
    content: string;
    sourceIds: string[];
    topic?: string;
    summary?: string;
    tags?: string[];
  }): MemoryEntry {
    const content = normalizeMemoryContent(input.content);
    if (!content) throw new Error('记忆内容不能为空');
    const now = new Date().toISOString();
    const contentHash = createHash('sha256').update(content).digest('hex');
    const allowedConversationIds = input.scope === 'shared' ? [] : [input.conversationId];
    const ownerId = input.scope === 'team' ? input.conversationId : input.botId;
    const duplicate = this.findDuplicate(input.scope, ownerId, allowedConversationIds, contentHash);
    if (duplicate) {
      const mergedSources = [...new Set([...duplicate.sourceIds, ...input.sourceIds])];
      if (mergedSources.length !== duplicate.sourceIds.length) {
        const updated: MemoryEntry = { ...duplicate, sourceIds: mergedSources, updatedAt: now };
        this.store.save(updated);
        return updated;
      }
      return duplicate;
    }
    const entry: MemoryEntry = {
      id: randomUUID(),
      scope: input.scope,
      ownerId,
      content,
      contentHash,
      ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
      ...(input.summary?.trim() ? { summary: memorySummary({ content, summary: input.summary, revision: 1 }), summaryRevision: 1 } : {}),
      ...(input.tags?.length ? { tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))] } : {}),
      createdBy: 'bot',
      updatedBy: 'bot',
      actorBotId: input.botId,
      sourceIds: [...new Set(input.sourceIds)],
      allowedConversationIds,
      status: 'candidate',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.store.save(entry);
    return entry;
  }

  resolve(id: string, approved: boolean): MemoryEntry {
    const entry = this.find(id);
    if (entry.status !== 'candidate') throw new Error('只允许审核候选记忆');
    return this.update(entry, approved ? 'approved' : 'revoked');
  }

  revoke(id: string): MemoryEntry {
    const entry = this.find(id);
    return entry.status === 'revoked' ? entry : this.update(entry, 'revoked');
  }

  private findDuplicate(scope: MemoryEntry['scope'], ownerId: string, allowedConversationIds: string[], contentHash: string): MemoryEntry | undefined {
    const targetAllowed = (scope === 'team' ? [ownerId] : [...new Set(allowedConversationIds)].sort()).join(',');
    return this.store.list().find(item => {
      if (item.status !== 'approved' && item.status !== 'candidate') return false;
      if (item.scope !== scope || item.ownerId !== ownerId) return false;
      const allowed = (item.scope === 'team' ? [item.ownerId] : [...new Set(item.allowedConversationIds)].sort()).join(',');
      if (allowed !== targetAllowed) return false;
      const hash = item.contentHash ?? createHash('sha256').update(normalizeMemoryContent(item.content)).digest('hex');
      return hash === contentHash;
    });
  }

  private sanitizeSourceIds(entry: MemoryEntry, conversationId: string): MemoryEntry {
    if (!this.store.canReadMessage || !entry.sourceIds.length) return entry;
    const filtered = entry.sourceIds.filter(sourceId => this.store.canReadMessage!(sourceId, conversationId));
    return filtered.length === entry.sourceIds.length ? entry : { ...entry, sourceIds: filtered };
  }

  private buildAuthorizedHistory(entries: MemoryEntry[], identity: MemoryIdentity) {
    const allById = new Map(this.store.list().map(item => [item.id, item]));
    return entries.map(entry => {
      const revisions = (this.store.revisions?.(entry.id) ?? [])
        .filter(rev => rev.scope === 'team'
          ? rev.ownerId === identity.conversationId
          : rev.allowedConversationIds.includes(identity.conversationId))
        .map(rev => ({
          ...rev,
          sourceIds: this.store.canReadMessage
            ? rev.sourceIds.filter(id => this.store.canReadMessage!(id, identity.conversationId))
            : rev.sourceIds,
        }));
      const supersededEntries = (entry.supersedes ?? [])
        .map(id => allById.get(id))
        .filter((item): item is MemoryEntry => !!item && (
          item.scope === 'team'
            ? item.ownerId === identity.conversationId
            : item.allowedConversationIds.includes(identity.conversationId) && (item.scope === 'shared' || item.ownerId === identity.botId)
        ))
        .map(item => this.sanitizeSourceIds(item, identity.conversationId));
      return {
        memoryId: entry.id,
        revisions,
        supersededEntries,
        consolidationReason: entry.consolidationReason,
      };
    });
  }

  private find(id: string): MemoryEntry {
    const entry = this.store.list().find(item => item.id === id);
    if (!entry) throw new Error('记忆不存在');
    return entry;
  }

  private update(entry: MemoryEntry, status: MemoryEntry['status']): MemoryEntry {
    this.store.saveRevision?.({
      id: `${entry.id}:${entry.revision}`,
      memoryId: entry.id,
      revision: entry.revision,
      content: entry.content,
      topic: entry.topic,
      summary: entry.summary,
      tags: entry.tags,
      pinned: entry.pinned,
      scope: entry.scope,
      ownerId: entry.ownerId,
      allowedConversationIds: entry.allowedConversationIds,
      sourceIds: entry.sourceIds,
      status: entry.status,
      createdBy: entry.createdBy,
      updatedBy: entry.updatedBy,
      actorBotId: entry.actorBotId,
      supersedes: entry.supersedes,
      supersededBy: entry.supersededBy,
      consolidationReason: entry.consolidationReason,
      createdAt: entry.updatedAt,
    });
    const updated = { ...entry, status, revision: entry.revision + 1, updatedAt: new Date().toISOString() };
    this.store.save(updated);
    return updated;
  }
}
