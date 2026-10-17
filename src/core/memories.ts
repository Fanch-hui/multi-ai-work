import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  Bot, Conversation, MemoryActor, MemoryConsolidationStatus, MemoryEntry, Task,
} from '../domain/types.js';
import {
  memoryPartitionKey, memorySummary, normalizeMemoryContent,
} from '../domain/memory.js';
import { MemoryService } from '../runtime/memory.js';
import { State, id, now } from './state.js';
import { TaskService } from './tasks.js';
import { required } from './errors.js';
import { assertUserMemorySources } from './memory-policy.js';
import {
  assertBatchConcurrency, buildRevisionSnapshot, getMemoryHistory,
  isUserProtectedMemory, mergeMemories, promoteMemory, recordBatchTouch,
} from './memory-merge.js';
import { schedulePartitionConsolidations } from './memory-consolidation.js';
import { findDuplicateMemory } from './memory-storage.js';

const fields = z.object({
  id: z.string().optional(),
  content: z.string().trim().min(1).max(20000),
  topic: z.string().trim().max(120).optional(),
  summary: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  pinned: z.boolean().optional(),
  scope: z.enum(['bot', 'team', 'shared']),
  ownerId: z.string().min(1),
  allowedConversationIds: z.array(z.string()).default([]),
  sourceIds: z.array(z.string()).default([]),
  expectedRevision: z.number().int().positive().optional(),
  consolidationReason: z.string().trim().max(500).optional(),
});

export interface MemoryWriteActor {
  kind: MemoryActor;
  botId?: string;
  task?: Task;
}

export class MemoryManagement {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private state: State, private memory: MemoryService, private tasks: TaskService) {}

  start() {
    this.unsubscribe = this.state.subscribe(kind => { if (kind === 'state') this.schedule(); });
    this.schedule();
  }
  close() { this.unsubscribe?.(); if (this.timer) clearTimeout(this.timer); }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; schedulePartitionConsolidations(this.state, this.tasks); }, 30);
  }

  private findPartitionDuplicate(scope: MemoryEntry['scope'], ownerId: string, allowedConversationIds: string[], contentHash: string, excludeId?: string) {
    return findDuplicateMemory(this.state.storage, scope, ownerId, allowedConversationIds, contentHash, excludeId);
  }

  propose(rawInput: unknown, actor: MemoryWriteActor = { kind: 'bot' }): MemoryEntry {
    const input = z.object({
      content: z.string().trim().min(1).max(20000),
      scope: z.enum(['bot', 'team', 'shared']),
      ownerId: z.string().min(1),
      allowedConversationIds: z.array(z.string()).default([]),
      sourceIds: z.array(z.string()).default([]),
      topic: z.string().trim().max(120).optional(),
      summary: z.string().trim().max(200).optional(),
      tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    }).parse(rawInput);
    const s = this.state.storage, content = normalizeMemoryContent(input.content);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const allowedConversationIds = input.scope === 'team' ? [input.ownerId] : [...new Set(input.allowedConversationIds)];
    const duplicate = this.findPartitionDuplicate(input.scope, input.ownerId, allowedConversationIds, contentHash);
    if (duplicate) {
      const mergedSources = [...new Set([...duplicate.sourceIds, ...input.sourceIds])];
      if (mergedSources.length !== duplicate.sourceIds.length) {
        const updated: MemoryEntry = { ...duplicate, sourceIds: mergedSources };
        s.put('memory_entries', updated); this.state.changed(); return updated;
      }
      return duplicate;
    }
    const timestamp = now();
    const memory: MemoryEntry = {
      id: id(), content, contentHash, scope: input.scope, ownerId: input.ownerId,
      allowedConversationIds, sourceIds: [...new Set(input.sourceIds)],
      ...(input.topic?.trim() ? { topic: input.topic.trim() } : {}),
      ...(input.summary?.trim() ? { summary: memorySummary({ content, summary: input.summary, revision: 1 }), summaryRevision: 1 } : {}),
      ...(input.tags?.length ? { tags: [...new Set(input.tags.map(t => t.trim()).filter(Boolean))] } : {}),
      ...(actor.botId ? { createdBy: actor.kind, updatedBy: actor.kind, actorBotId: actor.botId } : {}),
      status: 'candidate', revision: 1, createdAt: timestamp, updatedAt: timestamp,
    };
    s.put('memory_entries', memory); this.state.changed(); return memory;
  }

  save(input: unknown, actor: MemoryWriteActor = { kind: 'user' }): MemoryEntry {
    const parsed = fields.parse(input), s = this.state.storage;
    const old = parsed.id ? required(s.get<MemoryEntry>('memory_entries', parsed.id), '记忆不存在') : undefined;
    if (old && parsed.expectedRevision !== undefined && old.revision !== parsed.expectedRevision)
      throw new Error(`记忆版本已变化（预期 ${parsed.expectedRevision}，实际 ${old.revision}），请重新读取`);
    if (old?.status === 'superseded')
      throw new Error('该记忆已被合并替代，请刷新后编辑最新记忆');
    if (parsed.scope === 'bot') required(s.get<Bot>('bots', parsed.ownerId), '所属成员不存在');
    if (parsed.scope === 'team') required(s.get<Conversation>('conversations', parsed.ownerId), '所属会话不存在');
    for (const roomId of parsed.allowedConversationIds) required(s.get('conversations', roomId), '授权会话不存在');

    const content = normalizeMemoryContent(parsed.content);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const allowedConversationIds = parsed.scope === 'team' ? [parsed.ownerId] : [...new Set(parsed.allowedConversationIds)];
    assertBatchConcurrency(this.state, actor.task, old, {
      scope: parsed.scope,
      ownerId: parsed.ownerId,
      allowedConversationIds,
    });

    if (!old) {
      const duplicate = this.findPartitionDuplicate(parsed.scope, parsed.ownerId, allowedConversationIds, contentHash);
      if (duplicate && duplicate.status === 'approved') {
        const mergedSources = [...new Set([...duplicate.sourceIds, ...parsed.sourceIds])];
        if (mergedSources.length !== duplicate.sourceIds.length) {
          const updated: MemoryEntry = { ...duplicate, sourceIds: mergedSources };
          s.put('memory_entries', updated); this.state.changed(); return updated;
        }
        return duplicate;
      }
    }

    const contentChanged = old ? normalizeMemoryContent(old.content) !== content : true;
    if (old && actor.kind === 'memory-review' && isUserProtectedMemory(old)) {
      if (parsed.pinned === false && old.pinned) throw new Error('用户置顶的记忆不可由后台整理取消置顶');
      if (contentChanged) {
        const reviewSuggestion = {
          content,
          ...(parsed.topic?.trim() ? { topic: parsed.topic.trim() } : {}),
          ...(parsed.summary?.trim() ? { summary: parsed.summary.trim() } : {}),
          ...(parsed.consolidationReason ? { reason: parsed.consolidationReason } : {}),
          createdAt: now(),
        };
        const withSuggestion: MemoryEntry = { ...old, reviewSuggestion };
        s.put('memory_entries', withSuggestion); this.state.changed(); return withSuggestion;
      }
    }

    const revision = (old?.revision ?? 0) + 1;
    const nextTopic = parsed.topic !== undefined ? (parsed.topic.trim() || undefined) : old?.topic;
    const nextSummaryRaw = parsed.summary !== undefined ? (parsed.summary.trim() || undefined) : (!contentChanged ? old?.summary : undefined);
    const nextSummary = nextSummaryRaw ? memorySummary({ content, summary: nextSummaryRaw, revision }) : undefined;
    const nextTags = parsed.tags !== undefined ? [...new Set(parsed.tags.map(tag => tag.trim()).filter(Boolean))] : old?.tags;
    const nextPinned = parsed.pinned !== undefined ? parsed.pinned : old?.pinned;
    const nextUserMaintained = Boolean(
      old?.userMaintained || old?.createdBy === 'user' || old?.updatedBy === 'user' || actor.kind === 'user',
    );
    const nextCreatedBy = old?.createdBy ?? actor.kind;
    const nextUpdatedBy = actor.kind ?? old?.updatedBy;
    const nextActorBotId = actor.botId ?? old?.actorBotId;
    if (old) s.put('memory_revisions', buildRevisionSnapshot(old));

    const entry: MemoryEntry = {
      id: old?.id ?? id(), content, contentHash, scope: parsed.scope, ownerId: parsed.ownerId,
      sourceIds: parsed.sourceIds, allowedConversationIds,
      ...(nextTopic ? { topic: nextTopic } : {}),
      ...(nextSummary ? { summary: nextSummary, summaryRevision: revision } : {}),
      ...(nextTags?.length ? { tags: nextTags } : {}),
      ...(nextPinned !== undefined ? { pinned: nextPinned } : {}),
      ...(nextUserMaintained ? { userMaintained: true } : {}),
      ...(nextCreatedBy ? { createdBy: nextCreatedBy } : {}),
      ...(nextUpdatedBy ? { updatedBy: nextUpdatedBy } : {}),
      ...(nextActorBotId ? { actorBotId: nextActorBotId } : {}),
      ...(old?.supersedes?.length ? { supersedes: old.supersedes } : {}),
      ...(old?.promotedFromId ? { promotedFromId: old.promotedFromId } : {}),
      ...(parsed.consolidationReason ? { consolidationReason: parsed.consolidationReason } : (old?.consolidationReason ? { consolidationReason: old.consolidationReason } : {})),
      status: 'approved', revision, createdAt: old?.createdAt ?? now(), updatedAt: now(),
    };
    s.put('memory_entries', entry); recordBatchTouch(this.state, actor.task, entry); this.state.changed();
    return entry;
  }

  pin(memoryId: string, pinned: boolean): MemoryEntry {
    const entry = required(this.state.storage.get<MemoryEntry>('memory_entries', memoryId), '记忆不存在');
    return Boolean(entry.pinned) === pinned ? entry : this.save({ ...entry, pinned }, { kind: 'user' });
  }
  merge(rawInput: unknown, actor: MemoryWriteActor = { kind: 'user' }): MemoryEntry {
    return mergeMemories(this.state, rawInput, actor, () => true);
  }
  history(memoryId: string, conversationId?: string) { return getMemoryHistory(this.state, memoryId, conversationId); }
  consolidate(params?: { scope?: MemoryEntry['scope']; ownerId?: string }): MemoryConsolidationStatus[] {
    return schedulePartitionConsolidations(this.state, this.tasks, { manual: true, targetScope: params?.scope, targetOwnerId: params?.ownerId });
  }

  manage(input: Record<string, unknown>, botId: string, conversationId: string, task?: Task): unknown {
    const action = z.enum(['list', 'save', 'approve', 'revoke', 'merge', 'promote', 'history']).parse(input.action);
    const s = this.state.storage, actorKind: MemoryActor = task?.kind === 'memory-review' ? 'memory-review' : 'bot';
    const actor: MemoryWriteActor = { kind: actorKind, botId, task };
    const owns = (entry: Pick<MemoryEntry, 'scope' | 'ownerId'>) => entry.scope === 'bot' ? entry.ownerId === botId
      : botId === this.state.settings().mainBotId;
    const entry = input.id ? required(s.get<MemoryEntry>('memory_entries', z.string().parse(input.id)), '记忆不存在') : undefined;
    if (entry && action !== 'promote' && !owns(entry)) throw new Error('只能管理自己的记忆；团队公共记忆由管家管理');

    if (action === 'list') {
      if (entry) return entry;
      const allOwned = s.all<MemoryEntry>('memory_entries').filter(item => owns(item) && ['candidate', 'approved'].includes(item.status));
      if (task?.kind === 'memory-review') {
        const batch = s.metadata<{ partitionKey: string }>(`memory-batch:${task.id}`);
        if (batch) return allOwned.filter(item => memoryPartitionKey(item) === batch.partitionKey).slice(-200);
      }
      return allOwned.slice(-200);
    }
    if (action === 'history') {
      if (!entry) throw new Error('请指定要查看历史的记忆 ID');
      return getMemoryHistory(this.state, entry.id, conversationId);
    }
    if (action === 'merge') return mergeMemories(this.state, input, actor, owns);
    if (action === 'promote') return promoteMemory(this.state, input, botId, conversationId, task);
    if (action === 'revoke') return this.revoke(z.string().parse(input.id), actor);
    if (action === 'approve') {
      if (!entry) throw new Error('请选择要保存的记忆');
      const hasEdits = input.content !== undefined || input.topic !== undefined || input.summary !== undefined || input.tags !== undefined;
      if (entry.status === 'approved' && !hasEdits) return entry;
      return this.save({
        ...entry,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.topic !== undefined ? { topic: input.topic } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      }, actor);
    }
    const scope = input.scope ?? entry?.scope ?? 'bot';
    const ownerId = input.ownerId ?? (entry?.scope === scope ? entry.ownerId : scope === 'team' ? conversationId : botId);
    const parsed = fields.parse({ allowedConversationIds: [conversationId], ...entry, ...input, scope, ownerId, pinned: entry?.pinned });
    if (!owns(parsed)) throw new Error('不能修改其他成员的记忆');
    const authorizedRooms = parsed.scope === 'team' ? [parsed.ownerId] : [...new Set(parsed.allowedConversationIds)];
    assertBatchConcurrency(this.state, task, entry, {
      scope: parsed.scope,
      ownerId: parsed.ownerId,
      allowedConversationIds: authorizedRooms,
    });
    if (authorizedRooms.some(roomId => !s.get<Conversation>('conversations', roomId)?.memberIds.includes(botId)))
      throw new Error('记忆只能授权给自己参与的会话');
    if (!entry || parsed.sourceIds.length) assertUserMemorySources(this.state, parsed.sourceIds, authorizedRooms);
    return this.save(parsed, actor);
  }

  revoke(memoryId: string, actor?: MemoryWriteActor) {
    const s = this.state.storage, existing = s.get<MemoryEntry>('memory_entries', memoryId);
    if (existing) {
      assertBatchConcurrency(this.state, actor?.task, existing);
      if (actor?.kind === 'memory-review' && isUserProtectedMemory(existing))
        throw new Error('用户手动维护或置顶的记忆不可由后台整理自动停用');
    }
    const entry = this.memory.revoke(memoryId);
    if (actor) {
      const withActor: MemoryEntry = { ...entry, updatedBy: actor.kind, ...(actor.botId ? { actorBotId: actor.botId } : {}) };
      s.put('memory_entries', withActor); recordBatchTouch(this.state, actor.task, withActor); this.state.changed(); return withActor;
    }
    this.state.changed(); return entry;
  }
}
