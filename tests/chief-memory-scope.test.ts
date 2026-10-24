import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

describe('连续管家主段的记忆授权', () => {
  it('新主段继承固定入口的记忆，原分区与来源保持不变', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const chief = bot('Chief');
    const homeId = core.state.settings().mainConversationId!;
    const original = core.state.storage.appendMessage({
      id: id(),
      conversationId: homeId,
      authorType: 'user',
      content: '以后报告都用中文，先写结论。',
      artifactIds: [],
      status: 'committed',
      createdAt: now(),
    });
    const saved = core.memories.manage(
      { action: 'save', content: '报告用中文并先写结论', sourceIds: [original.id] },
      chief.id,
      homeId,
    ) as MemoryEntry;
    const before = core.state.storage.get<MemoryEntry>('memory_entries', saved.id);
    const main = core.chief.contexts.main();
    expect(main.room.id).not.toBe(homeId);

    expect(core.memory.instructions(chief.id, main.room.id)).toContain('报告用中文并先写结论');
    expect(
      core.memory.query({ botId: chief.id, conversationId: main.room.id }, { ids: [saved.id] }),
    ).toMatchObject([{ id: saved.id, sourceIds: [original.id], allowedConversationIds: [homeId] }]);
    expect(core.state.storage.get('memory_entries', saved.id)).toEqual(before);

    const work = core.chief.contexts.create({ kind: 'work', title: '报告制作' });
    const member = bot('成员');
    expect(core.memory.instructions(chief.id, work.conversationId)).toBe('');
    expect(core.memory.instructions(member.id, main.room.id)).toBe('');
  });

  it('跨段新增记忆仍归固定入口，保留当前与旧段的原始消息锚点', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const chief = bot('Chief');
    const first = core.chief.contexts.main();
    const source = core.state.storage.appendMessage({
      id: id(),
      conversationId: first.room.id,
      authorType: 'user',
      content: '以后报告请附上数据来源。',
      artifactIds: [],
      status: 'committed',
      createdAt: now(),
    });
    const candidate = core.memory.propose({
      botId: chief.id,
      conversationId: first.room.id,
      scope: 'bot',
      content: '报告须附数据来源',
      sourceIds: [source.id],
    });
    const saved = core.memories.manage(
      { action: 'approve', id: candidate.id },
      chief.id,
      first.room.id,
    ) as MemoryEntry;
    expect(saved.allowedConversationIds).toEqual([core.state.settings().mainConversationId]);

    const next = core.chief.contexts.rotate(first.context.id, '继续报告工作', [source.id], []);
    const recalled = core.memory.query(
      { botId: chief.id, conversationId: next.conversationId },
      { ids: [saved.id], includeHistory: true },
    ) as { entries: MemoryEntry[] };
    expect(recalled.entries[0].sourceIds).toEqual([source.id]);
    const history = core.memories.manage(
      { action: 'history', id: saved.id },
      chief.id,
      next.conversationId,
    ) as { memory: MemoryEntry };
    expect(history.memory.sourceIds).toEqual([source.id]);
    const further = core.memories.manage(
      { action: 'save', content: '报告引用数据来源', sourceIds: [source.id] },
      chief.id,
      next.conversationId,
    ) as MemoryEntry;
    expect(further.allowedConversationIds).toEqual([core.state.settings().mainConversationId]);
  });

  it('工作会话的用户消息保持独立，不能成为主对话偏好的隐式来源', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const chief = bot('Chief');
    const main = core.chief.contexts.main();
    const work = core.chief.contexts.create({ kind: 'work', title: '独立工作' });
    const source = core.state.storage.appendMessage({
      id: id(),
      conversationId: work.conversationId,
      authorType: 'user',
      content: '以后这项工作都用英文。',
      artifactIds: [],
      status: 'committed',
      createdAt: now(),
    });
    expect(() =>
      core.memories.manage(
        { action: 'save', content: '以后用英文', sourceIds: [source.id] },
        chief.id,
        main.room.id,
      ),
    ).toThrow('获准会话中的用户消息');
    const scoped = core.memories.manage(
      { action: 'save', content: '这项工作用英文', sourceIds: [source.id] },
      chief.id,
      work.conversationId,
    ) as MemoryEntry;
    expect(scoped.allowedConversationIds).toEqual([work.conversationId]);
    expect(core.memory.instructions(chief.id, main.room.id)).toBe('');
  });
});
