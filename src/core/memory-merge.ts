import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  Conversation, MemoryActor, MemoryEntry, MemoryRevisionRecord, Task,
} from '../domain/types.js';
import {
  memoryPartitionKey, memorySummary, normalizeMemoryContent, normalizedAllowedConversations,
} from '../domain/memory.js';
import { State, id, now } from './state.js';
import { required } from './errors.js';
import { assertUserMemorySources } from './memory-policy.js';
import { listMemoryRevisions } from './memory-storage.js';

export interface MemoryBatchMeta {
  taskId: string;
  partitionKey: string;
  fingerprint: string;
  scope: MemoryEntry['scope'];
  ownerId: string;
  allowedConversationIds: string[];
  initialRevisions: Record<string, number>;
  touchedRevisions: Record<string, number>;
}

export function isUserProtectedMemory(entry: MemoryEntry): boolean {
  return entry.createdBy === 'user' || entry.updatedBy === 'user' || !!entry.pinned;
}

export function buildRevisionSnapshot(entry: MemoryEntry): MemoryRevisionRecord {
  return {
    id: `${entry.id}:${entry.revision}`,
    memoryId: entry.id,
    revision: entry.revision,
    content: entry.content,
    ...(entry.topic ? { topic: entry.topic } : {}),
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.tags?.length ? { tags: entry.tags } : {}),
    ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
    scope: entry.scope,
    ownerId: entry.ownerId,
    allowedConversationIds: entry.allowedConversationIds,
    sourceIds: entry.sourceIds,
    status: entry.status,
    createdBy: entry.createdBy ?? 'unknown',
    updatedBy: entry.updatedBy ?? 'unknown',
    ...(entry.actorBotId ? { actorBotId: entry.actorBotId } : {}),
    ...(entry.supersedes?.length ? { supersedes: entry.supersedes } : {}),
    ...(entry.supersededBy ? { supersededBy: entry.supersededBy } : {}),
    ...(entry.consolidationReason ? { consolidationReason: entry.consolidationReason } : {}),
    createdAt: entry.updatedAt,
  };
}

export function assertBatchConcurrency(state: State, task: Task | undefined, entry: MemoryEntry) {
  if (task?.kind !== 'memory-review') return;
  const batch = state.storage.metadata<MemoryBatchMeta>(`memory-batch:${task.id}`);
  if (!batch) return;
  if (memoryPartitionKey(entry) !== batch.partitionKey) {
    throw new Error('后台整理仅可操作当前批次授权分区的记忆');
  }
  const expected = batch.touchedRevisions[entry.id] ?? batch.initialRevisions[entry.id];
  if (expected !== undefined && entry.revision !== expected) {
    throw new Error('记忆在后台整理期间已被修改，已拒绝覆盖最新内容');
  }
}

export function recordBatchTouch(state: State, task: Task | undefined, entry: MemoryEntry) {
  if (task?.kind !== 'memory-review') return;
  const key = `memory-batch:${task.id}`;
  const batch = state.storage.metadata<MemoryBatchMeta>(key);
  if (!batch) return;
  batch.touchedRevisions[entry.id] = entry.revision;
  state.storage.setMetadata(key, batch);
}

const mergeSchema = z.object({
  sourceEntries: z.array(z.object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })).min(1).max(30),
  content: z.string().trim().min(1).max(20000),
  topic: z.string().trim().max(120).optional(),
  summary: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  reason: z.string().trim().max(500).optional(),
  sourceIds: z.array(z.string()).max(50).optional(),
});

export function mergeMemories(
  state: State,
  rawInput: unknown,
  actor: { kind: MemoryActor; botId?: string; task?: Task },
  owns: (entry: Pick<MemoryEntry, 'scope' | 'ownerId'>) => boolean,
): MemoryEntry {
  const input = mergeSchema.parse(rawInput);
  const s = state.storage;
  const content = normalizeMemoryContent(input.content);
  if (!content) throw new Error('合并后的记忆内容不能为空');
  const contentHash = createHash('sha256').update(content).digest('hex');

  const merged = s.transaction(() => {
    const entries = input.sourceEntries.map(spec => {
      const entry = required(s.get<MemoryEntry>('memory_entries', spec.id), `记忆不存在：${spec.id}`);
      if (!owns(entry)) throw new Error('只能合并自己负责的记忆');
      if (entry.status !== 'approved' && entry.status !== 'candidate') {
        throw new Error(`只能合并有效或候选记忆：${entry.id}`);
      }
      if (entry.revision !== spec.revision) {
        throw new Error(`记忆 ${entry.id} 版本已变化（预期 ${spec.revision}，实际 ${entry.revision}），请重新读取`);
      }
      assertBatchConcurrency(state, actor.task, entry);
      if (actor.kind === 'memory-review' && isUserProtectedMemory(entry)) {
        throw new Error(`记忆 ${entry.id} 为用户手动维护或置顶内容，后台整理不可直接合并替代`);
      }
      return entry;
    });

    const uniqueIds = new Set(entries.map(item => item.id));
    if (uniqueIds.size !== entries.length) throw new Error('合并来源包含重复 ID');

    const first = entries[0];
    const partition = memoryPartitionKey(first);
    for (const entry of entries.slice(1)) {
      if (memoryPartitionKey(entry) !== partition) {
        throw new Error('首版仅允许合并相同使用范围、归属和授权会话集合的记忆，不自动扩大授权');
      }
    }

    const allowedConversationIds = normalizedAllowedConversations(first);
    if (input.sourceIds?.length) {
      assertUserMemorySources(state, input.sourceIds, allowedConversationIds);
    }
    const combinedSources = [...new Set([
      ...entries.flatMap(entry => entry.sourceIds),
      ...(input.sourceIds ?? []),
    ])];

    const timestamp = now();
    const nextTopic = input.topic?.trim() || entries.find(item => item.topic?.trim())?.topic;
    const nextTags = input.tags?.length
      ? [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))]
      : [...new Set(entries.flatMap(item => item.tags ?? []))];
    const nextSummary = input.summary?.trim()
      ? memorySummary({ content, summary: input.summary, revision: 1 })
      : undefined;

    const newEntry: MemoryEntry = {
      id: id(),
      scope: first.scope,
      ownerId: first.ownerId,
      content,
      contentHash,
      ...(nextTopic ? { topic: nextTopic } : {}),
      ...(nextSummary ? { summary: nextSummary, summaryRevision: 1 } : {}),
      ...(nextTags.length ? { tags: nextTags } : {}),
      createdBy: actor.kind,
      updatedBy: actor.kind,
      ...(actor.botId ? { actorBotId: actor.botId } : {}),
      supersedes: entries.map(entry => entry.id),
      ...(input.reason ? { consolidationReason: input.reason } : {}),
      sourceIds: combinedSources,
      allowedConversationIds,
      status: 'approved',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    for (const oldEntry of entries) {
      s.put('memory_revisions', buildRevisionSnapshot(oldEntry));
      const superseded: MemoryEntry = {
        ...oldEntry,
        status: 'superseded',
        supersededBy: newEntry.id,
        ...(input.reason ? { consolidationReason: input.reason } : {}),
        updatedBy: actor.kind,
        ...(actor.botId ? { actorBotId: actor.botId } : {}),
        revision: oldEntry.revision + 1,
        updatedAt: timestamp,
      };
      s.put('memory_entries', superseded);
      recordBatchTouch(state, actor.task, superseded);
    }

    s.put('memory_entries', newEntry);
    recordBatchTouch(state, actor.task, newEntry);
    return newEntry;
  });

  state.changed();
  return merged;
}

const promoteSchema = z.object({
  id: z.string().min(1),
  content: z.string().trim().min(1).max(20000).optional(),
  scope: z.enum(['team', 'shared']),
  ownerId: z.string().min(1).optional(),
  allowedConversationIds: z.array(z.string()).max(100).optional(),
  topic: z.string().trim().max(120).optional(),
  summary: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  reason: z.string().trim().max(500).optional(),
});

export function promoteMemory(
  state: State,
  rawInput: unknown,
  botId: string,
  conversationId: string,
): MemoryEntry {
  if (botId !== state.settings().mainBotId) {
    throw new Error('个人记忆晋升公共记忆仅允许由管家执行');
  }
  const input = promoteSchema.parse(rawInput);
  const s = state.storage;
  const source = required(s.get<MemoryEntry>('memory_entries', input.id), '源记忆不存在');
  if (source.scope !== 'bot') throw new Error('只能将成员个人记忆晋升为公共记忆');
  const scope = input.scope;
  const ownerId = scope === 'team' ? (input.ownerId ?? conversationId) : (input.ownerId ?? 'shared');
  if (scope === 'team') required(s.get<Conversation>('conversations', ownerId), '目标团队会话不存在');
  const allowed = scope === 'team'
    ? [ownerId]
    : [...new Set(input.allowedConversationIds?.length ? input.allowedConversationIds : [conversationId])];
  for (const roomId of allowed) {
    const room = required(s.get<Conversation>('conversations', roomId), '目标授权会话不存在');
    if (!room.memberIds.includes(botId)) throw new Error('公共记忆只能授权给管家参与的会话');
  }
  const publicSourceIds = source.sourceIds.filter(msgId => {
    const msg = s.getMessage(msgId);
    return !!msg && allowed.includes(msg.conversationId);
  });
  const content = normalizeMemoryContent(input.content ?? source.content);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const timestamp = now();
  const nextTopic = input.topic?.trim() || source.topic;
  const nextTags = input.tags?.length ? [...new Set(input.tags)] : source.tags;
  const nextSummary = input.summary?.trim()
    ? memorySummary({ content, summary: input.summary, revision: 1 })
    : (content === normalizeMemoryContent(source.content) ? source.summary : undefined);

  const promoted: MemoryEntry = {
    id: id(),
    scope,
    ownerId,
    content,
    contentHash,
    ...(nextTopic ? { topic: nextTopic } : {}),
    ...(nextSummary ? { summary: nextSummary, summaryRevision: 1 } : {}),
    ...(nextTags?.length ? { tags: nextTags } : {}),
    createdBy: 'bot',
    updatedBy: 'bot',
    actorBotId: botId,
    promotedFromId: source.id,
    ...(input.reason ? { consolidationReason: input.reason } : {}),
    sourceIds: publicSourceIds,
    allowedConversationIds: allowed,
    status: 'approved',
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  s.put('memory_entries', promoted);
  state.changed();
  return promoted;
}

export function getMemoryHistory(state: State, memoryId: string, conversationId?: string) {
  const s = state.storage;
  const entry = required(s.get<MemoryEntry>('memory_entries', memoryId), '记忆不存在');
  const filterSources = (sourceIds: string[]) => {
    if (!conversationId) return sourceIds;
    return sourceIds.filter(msgId => s.getMessage(msgId)?.conversationId === conversationId);
  };
  const revisions = listMemoryRevisions(s, memoryId).map(rev => ({
    ...rev,
    sourceIds: filterSources(rev.sourceIds),
  }));
  const supersededEntries = (entry.supersedes ?? [])
    .map(oldId => s.get<MemoryEntry>('memory_entries', oldId))
    .filter((item): item is MemoryEntry => !!item)
    .map(item => ({ ...item, sourceIds: filterSources(item.sourceIds) }));
  const supersededByEntry = entry.supersededBy ? s.get<MemoryEntry>('memory_entries', entry.supersededBy) : undefined;
  return {
    memory: { ...entry, sourceIds: filterSources(entry.sourceIds) },
    revisions,
    supersededEntries,
    ...(supersededByEntry ? { supersededByEntry: { ...supersededByEntry, sourceIds: filterSources(supersededByEntry.sourceIds) } } : {}),
  };
}
