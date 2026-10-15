import { randomUUID } from 'node:crypto';
import type { MemoryEntry } from '../domain/types.js';

export interface MemoryStore {
  list(): MemoryEntry[];
  save(entry: MemoryEntry): void;
}

export interface MemoryIdentity {
  botId: string;
  conversationId: string;
  memberIds?: string[];
}

function terms(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const chinese = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  return [...new Set([...tokens, ...chinese.flatMap(word =>
    Array.from(word).flatMap((_, index) => index < word.length - 1 ? [word.slice(index, index + 2)] : []))])];
}

function authorized(entry: MemoryEntry, identity: MemoryIdentity): boolean {
  if (entry.status !== 'approved') return false;
  if (entry.scope === 'team') return entry.ownerId === identity.conversationId;
  if (entry.scope === 'shared') return entry.allowedConversationIds.includes(identity.conversationId);
  return entry.ownerId === identity.botId && entry.allowedConversationIds.includes(identity.conversationId);
}

export class MemoryService {
  constructor(private readonly store: MemoryStore) {}

  recall(identity: MemoryIdentity, query: string, limit = 8): MemoryEntry[] {
    const keywords = terms(query.trim());
    return this.store.list().filter(entry => authorized(entry, identity))
      .map(entry => ({ entry, score: keywords.reduce((score, word) =>
        score + Number(entry.content.toLocaleLowerCase().includes(word)), 0) }))
      .filter(item => keywords.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, Math.max(0, limit)).map(item => item.entry);
  }

  propose(input: MemoryIdentity & { scope: MemoryEntry['scope']; content: string; sourceIds: string[] }): MemoryEntry {
    const content = input.content.trim();
    if (!content) throw new Error('记忆内容不能为空');
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(), scope: input.scope,
      ownerId: input.scope === 'team' ? input.conversationId : input.botId,
      content, sourceIds: [...new Set(input.sourceIds)],
      allowedConversationIds: input.scope === 'shared' ? [] : [input.conversationId],
      status: 'candidate', revision: 1, createdAt: now, updatedAt: now,
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

  instructions(botId: string, conversationId: string): string {
    const entries = this.recall({ botId, conversationId }, '', 8);
    if (entries.length === 0) return '';
    return `长期记忆（背景资料）：\n${entries.map(entry => `[${entry.id}@${entry.revision}] ${entry.content.slice(0, 1500)}`).join('\n')}`;
  }

  private find(id: string): MemoryEntry {
    const entry = this.store.list().find(item => item.id === id);
    if (!entry) throw new Error('记忆不存在');
    return entry;
  }

  private update(entry: MemoryEntry, status: MemoryEntry['status']): MemoryEntry {
    const updated = { ...entry, status, revision: entry.revision + 1, updatedAt: new Date().toISOString() };
    this.store.save(updated);
    return updated;
  }
}
