import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../src/domain/types.js';
import { setup } from './core-harness.js';
import { id, now } from '../src/core/state.js';

describe('记忆工具的默认归属', () => {
  it('管家省略ownerId仍将公共记忆归当前App会话，成员可以读取，撤销后退出检索', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const chief = bot('Chief'), member = bot('成员');
    const room = core.entities.createConversation({ name: '团队', kind: 'group', chiefId: chief.id,
      memberIds: [chief.id, member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const source = core.state.storage.appendMessage({ id: id(), conversationId: room.id, content: '我习惯每天学习60分钟',
      authorType: 'user', artifactIds: [], status: 'committed', createdAt: now() });
    const saved = core.memories.manage({ action: 'save', scope: 'team', content: '用户习惯每日学习60分钟', sourceIds: [source.id] }, chief.id, room.id) as MemoryEntry;
    expect(saved).toMatchObject({ ownerId: room.id, allowedConversationIds: [room.id], status: 'approved' });
    expect(core.memory.recall({ botId: member.id, conversationId: room.id }, '每日60分钟').map(entry => entry.id)).toContain(saved.id);
    core.memories.manage({ action: 'revoke', id: saved.id }, chief.id, room.id);
    expect(core.memory.recall({ botId: member.id, conversationId: room.id }, '每日60分钟')).toEqual([]);
  });

  it('成员个人记忆默认归自己及当前会话，公共记忆仍由管家管理', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员');
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const source = core.state.storage.appendMessage({ id: id(), conversationId: room.id, content: '以后请用中文交付',
      authorType: 'user', artifactIds: [], status: 'committed', createdAt: now() });
    const saved = core.memories.manage({ action: 'save', content: '用户要求中文交付', sourceIds: [source.id] }, member.id, room.id) as MemoryEntry;
    expect(saved).toMatchObject({ scope: 'bot', ownerId: member.id, allowedConversationIds: [room.id] });
    expect(() => core.memories.manage({ action: 'save', scope: 'team', content: '越权' }, member.id, room.id)).toThrow('不能修改其他成员');
  });
  it('自动新增记忆只接受获准会话的用户来源，用户手动编辑仍有效', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员'), workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({ name: '当前', kind: 'private', memberIds: [member.id], workspaceId });
    const other = core.entities.createConversation({ name: '其他', kind: 'private', memberIds: [member.id], workspaceId });
    const append = (conversationId: string, authorType: 'user' | 'bot') => core.state.storage.appendMessage({ id: id(), conversationId,
      authorType, content: '以后提供简洁步骤', artifactIds: [], status: 'committed', createdAt: now() });
    const discussion = append(room.id, 'bot'), elsewhere = append(other.id, 'user');
    expect(() => core.memories.manage({ action: 'save', content: '偏好简洁步骤' }, member.id, room.id)).toThrow('原始消息');
    for (const sourceIds of [[discussion.id], [elsewhere.id]])
      expect(() => core.memories.manage({ action: 'save', content: '偏好简洁步骤', sourceIds }, member.id, room.id)).toThrow('用户消息');
    expect(core.state.storage.all('memory_entries')).toEqual([]);
    const manual = await core.request('memories.save', { scope: 'bot', ownerId: member.id,
      allowedConversationIds: [room.id], content: '用户手动维护的偏好' }) as MemoryEntry;
    expect(manual.status).toBe('approved');
  });
});
