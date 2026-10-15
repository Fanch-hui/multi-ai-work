import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../src/domain/types.js';
import { MemoryService } from '../src/runtime/memory.js';

function setup() {
  const entries = new Map<string, MemoryEntry>();
  const service = new MemoryService({ list: () => [...entries.values()], save: entry => { entries.set(entry.id, entry); } });
  return { entries, service };
}

describe('MemoryService', () => {
  it('只检索当前身份有权使用的已批准记忆', () => {
    const { service, entries } = setup();
    const privateEntry = service.propose({ botId: 'a', conversationId: 'private', scope: 'bot', content: '文档必须保存原始来源', sourceIds: ['m1'] });
    const teamEntry = service.propose({ botId: 'a', conversationId: 'room', scope: 'team', content: '文档使用中文标题', sourceIds: ['m2'] });
    const sharedEntry = service.propose({ botId: 'a', conversationId: 'private', scope: 'shared', content: '文档引用页码', sourceIds: ['m3'] });
    [privateEntry, teamEntry, sharedEntry].forEach(entry => service.resolve(entry.id, true));
    expect(service.recall({ botId: 'a', conversationId: 'room' }, '文档').map(entry => entry.id)).toEqual([teamEntry.id]);
    entries.set(sharedEntry.id, { ...entries.get(sharedEntry.id)!, allowedConversationIds: ['room'] });
    expect(service.recall({ botId: 'b', conversationId: 'room' }, '文档')).toHaveLength(2);
    expect(service.recall({ botId: 'b', conversationId: 'private' }, '文档')).toEqual([]);
    expect(service.recall({ botId: 'a', conversationId: 'private' }, '原始来源')[0].id).toBe(privateEntry.id);
  });

  it('批准与撤销改变实际注入内容和版本', () => {
    const { service } = setup();
    const entry = service.propose({ botId: 'a', conversationId: 'room', scope: 'bot', content: '使用简洁中文', sourceIds: [] });
    expect(service.instructions('a', 'room')).toBe('');
    expect(service.resolve(entry.id, true).revision).toBe(2);
    expect(service.instructions('a', 'room')).toContain('使用简洁中文');
    expect(service.revoke(entry.id).revision).toBe(3);
    expect(service.instructions('a', 'room')).toBe('');
    expect(() => service.resolve(entry.id, true)).toThrow('只允许审核候选记忆');
  });
});
