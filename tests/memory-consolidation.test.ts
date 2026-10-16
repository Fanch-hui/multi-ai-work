import { describe, expect, it } from 'vitest';
import type { Bot, MemoryEntry, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';
import { id, now } from '../src/core/state.js';

describe('记忆整理、版本溯源与并发保护', () => {
  it('同一分区内按内容哈希确定性去重并合并来源，不递增语义版本；跨分区独立保存', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const roomA = core.entities.createConversation({ name: '会话甲', kind: 'private', memberIds: [member.id], workspaceId });
    const roomB = core.entities.createConversation({ name: '会话乙', kind: 'private', memberIds: [member.id], workspaceId });

    const first = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomA.id],
      sourceIds: ['msg-1'],
      content: '  统一使用 TypeScript 严格模式\r\n ',
    });
    expect(first.revision).toBe(1);

    const duplicate = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomA.id],
      sourceIds: ['msg-2'],
      content: '统一使用 TypeScript 严格模式',
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.revision).toBe(1);
    expect(duplicate.sourceIds).toEqual(['msg-1', 'msg-2']);

    const otherPartition = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomB.id],
      sourceIds: ['msg-3'],
      content: '统一使用 TypeScript 严格模式',
    });
    expect(otherPartition.id).not.toBe(first.id);
  });

  it('编辑记忆自动保存历史版本快照，支持按需查询完整修订与合并溯源', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({ name: '开发', kind: 'private', memberIds: [member.id], workspaceId });

    const created = await core.request('memories.save', {
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '代码风格',
      content: '函数长度不超过 80 行',
    }) as MemoryEntry;

    const updated = await core.request('memories.save', {
      id: created.id,
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '代码风格',
      content: '函数长度不超过 50 行',
    }) as MemoryEntry;
    expect(updated.revision).toBe(2);

    const history = await core.request('memories.history', { id: created.id }) as {
      memory: MemoryEntry;
      revisions: Array<{ revision: number; content: string }>;
    };
    expect(history.memory.revision).toBe(2);
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]).toMatchObject({
      revision: 1,
      content: '函数长度不超过 80 行',
    });
  });

  it('原子合并要求同一授权分区并校验源条目版本，版本不匹配时整批回滚', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const roomA = core.entities.createConversation({ name: '会话甲', kind: 'private', memberIds: [member.id], workspaceId });
    const roomB = core.entities.createConversation({ name: '会话乙', kind: 'private', memberIds: [member.id], workspaceId });

    const entry1 = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomA.id],
      sourceIds: ['m1'],
      topic: '交付格式',
      content: '交付文档使用中文标题',
    }, { kind: 'bot', botId: member.id });

    const entry2 = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomA.id],
      sourceIds: ['m2'],
      topic: '交付格式',
      content: '交付文档附上执行摘要',
    }, { kind: 'bot', botId: member.id });

    const entryOtherRoom = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomB.id],
      sourceIds: ['m3'],
      content: '另一会话规则',
    }, { kind: 'bot', botId: member.id });

    expect(() => core.memories.merge({
      sourceEntries: [
        { id: entry1.id, revision: entry1.revision },
        { id: entryOtherRoom.id, revision: entryOtherRoom.revision },
      ],
      content: '跨会话合并应拒绝',
    })).toThrow('相同使用范围');

    expect(() => core.memories.merge({
      sourceEntries: [
        { id: entry1.id, revision: entry1.revision },
        { id: entry2.id, revision: 99 },
      ],
      content: '版本错误合并应拒绝',
    })).toThrow('版本已变化');

    expect(core.state.storage.get<MemoryEntry>('memory_entries', entry1.id)?.status).toBe('approved');
    expect(core.state.storage.get<MemoryEntry>('memory_entries', entry2.id)?.status).toBe('approved');

    const merged = await core.request('memories.merge', {
      sourceEntries: [
        { id: entry1.id, revision: entry1.revision },
        { id: entry2.id, revision: entry2.revision },
      ],
      topic: '交付格式',
      summary: '中文标题并附执行摘要',
      content: '交付文档统一使用中文标题，并在开头附上执行摘要。',
      reason: '合并同类交付格式要求',
    }) as MemoryEntry;

    expect(merged.status).toBe('approved');
    expect(merged.supersedes).toEqual([entry1.id, entry2.id]);
    expect(merged.sourceIds).toEqual(['m1', 'm2']);

    const old1 = core.state.storage.get<MemoryEntry>('memory_entries', entry1.id)!;
    const old2 = core.state.storage.get<MemoryEntry>('memory_entries', entry2.id)!;
    expect(old1.status).toBe('superseded');
    expect(old1.supersededBy).toBe(merged.id);
    expect(old2.status).toBe('superseded');
    expect(old2.supersededBy).toBe(merged.id);

    await expect(core.request('memories.save', {
      ...entry1,
      content: '旧编辑弹窗试图覆盖已合并条目',
      expectedRevision: entry1.revision,
    })).rejects.toThrow('记忆版本已变化');
    await expect(core.request('memories.save', {
      ...old1,
      content: '忽略版本号也不可覆盖已合并条目',
    })).rejects.toThrow('已被合并替代');
    expect(core.state.storage.get<MemoryEntry>('memory_entries', entry1.id)?.status).toBe('superseded');

    const recalled = core.memory.recall({ botId: member.id, conversationId: roomA.id }, '交付文档');
    expect(recalled.map(item => item.id)).toEqual([merged.id]);
  });

  it('用户手动维护或置顶条目受保护：后台补主题不清除保护、后台整理不能扩大授权范围，且用户并发编辑优先', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id], workspaceId });
    const roomB = core.entities.createConversation({ name: '另一私聊', kind: 'private', memberIds: [member.id], workspaceId });
    const userMsg = core.state.storage.appendMessage({
      id: id(), conversationId: room.id, authorType: 'user', content: '用户原始发言', artifactIds: [], status: 'committed', createdAt: now(),
    });

    // Bot creates -> User edits -> Background supplements topic -> Still protected on next background pass
    const botCreated = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      sourceIds: [userMsg.id],
      content: '模型最初记录的偏好',
    }, { kind: 'bot', botId: member.id });
    const userEntry = await core.request('memories.save', {
      ...botCreated,
      content: '用户亲手修改后的核心偏好',
      expectedRevision: botCreated.revision,
    }) as MemoryEntry;
    expect(userEntry.userMaintained).toBe(true);

    const reviewTask: Task = {
      id: 'task-review-1',
      conversationId: room.id,
      botId: member.id,
      requestId: `memory:bot:${member.id}:test`,
      depth: 0,
      kind: 'memory-review',
      goal: '整理记忆',
      expectedOutput: '完成',
      status: 'running',
      dependencyIds: [],
      artifactIds: [],
      runIds: [],
      createdAt: now(),
      updatedAt: now(),
    };
    core.state.storage.setMetadata(`memory-batch:${reviewTask.id}`, {
      taskId: reviewTask.id,
      partitionKey: `bot:${member.id}:${room.id}`,
      fingerprint: 'fp1',
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      initialRevisions: { [userEntry.id]: userEntry.revision },
      touchedRevisions: {},
    });

    // Background task cannot expand allowedConversationIds on existing or new entries
    expect(() => core.memories.manage({
      action: 'save',
      id: userEntry.id,
      content: userEntry.content,
      allowedConversationIds: [room.id, roomB.id],
    }, member.id, room.id, reviewTask)).toThrow('后台整理不可更改记忆的使用范围');
    expect(() => core.memories.manage({
      action: 'save',
      content: '跨分区新建记忆',
      allowedConversationIds: [room.id, roomB.id],
    }, member.id, room.id, reviewTask)).toThrow('后台整理仅可写入当前批次授权分区的记忆');
    expect(core.memory.recall({ botId: member.id, conversationId: roomB.id }, '核心偏好')).toEqual([]);

    // Background supplements topic without changing content -> updatedBy becomes memory-review, but userMaintained stays true
    const topicSupplemented = core.memories.manage({
      action: 'save',
      id: userEntry.id,
      content: userEntry.content,
      topic: '已补全主题',
    }, member.id, room.id, reviewTask) as MemoryEntry;
    expect(topicSupplemented.updatedBy).toBe('memory-review');
    expect(topicSupplemented.userMaintained).toBe(true);

    expect(() => core.memories.manage({ action: 'revoke', id: userEntry.id }, member.id, room.id, reviewTask))
      .toThrow('用户手动维护或置顶');

    const suggested = core.memories.manage({
      action: 'save',
      id: userEntry.id,
      content: '后台试图改写用户正文',
      topic: '核心偏好',
      consolidationReason: '尝试润色',
    }, member.id, room.id, reviewTask) as MemoryEntry;

    expect(suggested.content).toBe('用户亲手修改后的核心偏好');
    expect(suggested.revision).toBe(3);
    expect(suggested.reviewSuggestion).toMatchObject({
      content: '后台试图改写用户正文',
      topic: '核心偏好',
    });

    // Simulate concurrent user edit while background review batch is still open
    await core.request('memories.save', {
      ...suggested,
      content: '用户在后台整理期间更新了偏好',
      expectedRevision: suggested.revision,
    });

    expect(() => core.memories.manage({
      action: 'save',
      id: userEntry.id,
      content: '用户在后台整理期间更新了偏好',
      topic: '补充主题',
    }, member.id, room.id, reviewTask)).toThrow('后台整理期间已被修改');
  });

  it('仅允许管家将个人记忆显式晋升为公共记忆，且自动剥离私聊来源消息引用', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    const member = bot('成员');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const privateRoom = core.entities.createConversation({ name: '成员私聊', kind: 'private', memberIds: [member.id], workspaceId });
    const groupRoom = core.entities.createConversation({ name: '项目群', kind: 'group', chiefId: chief.id, memberIds: [chief.id, member.id], workspaceId });

    const privateMsg = core.state.storage.appendMessage({
      id: id(), conversationId: privateRoom.id, authorType: 'user', content: '私聊里的要求', artifactIds: [], status: 'committed', createdAt: now(),
    });
    const groupMsg = core.state.storage.appendMessage({
      id: id(), conversationId: groupRoom.id, authorType: 'user', content: '群里的公共要求', artifactIds: [], status: 'committed', createdAt: now(),
    });

    const personal = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [privateRoom.id, groupRoom.id],
      sourceIds: [privateMsg.id, groupMsg.id],
      topic: '术语规范',
      content: '产品名称统一写为 multi-AI work',
    }, { kind: 'bot', botId: member.id });

    expect(() => core.memories.manage({
      action: 'promote',
      id: personal.id,
      scope: 'team',
      ownerId: groupRoom.id,
    }, member.id, groupRoom.id)).toThrow('仅允许由管家执行');

    const promoted = core.memories.manage({
      action: 'promote',
      id: personal.id,
      scope: 'team',
      ownerId: groupRoom.id,
      reason: '升级为项目群公共术语规范',
    }, chief.id, groupRoom.id) as MemoryEntry;

    expect(promoted.scope).toBe('team');
    expect(promoted.ownerId).toBe(groupRoom.id);
    expect(promoted.promotedFromId).toBe(personal.id);
    expect(promoted.sourceIds).toEqual([groupMsg.id]);
  });

  it('同分区多条候选合并为单次后台批量整理任务，手动整理幂等复用', async () => {
    const mergedIds: string[] = [];
    const { core, connection } = await setup(async context => {
      if (context.prompt.includes('整理长期记忆')) {
        const list = await context.executeTool('manage_memory', { action: 'list' }, 'list-batch') as MemoryEntry[];
        const candidates = list.filter(item => item.status === 'candidate');
        for (const item of candidates) {
          mergedIds.push(item.id);
          await context.executeTool('manage_memory', {
            action: 'approve',
            id: item.id,
            topic: '团队规范',
            summary: item.content,
          }, `approve-${item.id}`);
        }
      }
      return { text: '批量整理完成' };
    });

    const snapshot = core.state.snapshot();
    const chief = await core.request('chief.configure', {
      input: {
        ...snapshot.bots.find(item => item.id === snapshot.settings.mainBotId)!,
        connectionId: connection.id,
        model: 'test',
      },
    }) as Bot;
    const group = core.entities.createConversation({
      name: '协作群',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id],
      workspaceId: snapshot.workspaces[0].id,
    });

    const c1 = await core.request('memories.propose', {
      content: '周报使用 Markdown 表格',
      scope: 'team',
      ownerId: group.id,
      allowedConversationIds: [group.id],
    }) as MemoryEntry;
    const c2 = await core.request('memories.propose', {
      content: '代码提交前运行类型检查',
      scope: 'team',
      ownerId: group.id,
      allowedConversationIds: [group.id],
    }) as MemoryEntry;

    await eventually(() =>
      core.state.storage.get<MemoryEntry>('memory_entries', c1.id)?.status === 'approved'
      && core.state.storage.get<MemoryEntry>('memory_entries', c2.id)?.status === 'approved',
    );

    const reviewTasks = core.state.snapshot().tasks.filter(task => task.kind === 'memory-review');
    expect(reviewTasks).toHaveLength(1);
    expect(mergedIds.sort()).toEqual([c1.id, c2.id].sort());
  });

  it('召回与注入统计独立存储在 memory_usage，不递增 revision/updatedAt，且随备份恢复完整保留', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('成员');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({ name: '工作', kind: 'private', memberIds: [member.id], workspaceId });

    const entry = await core.request('memories.save', {
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '写作规范',
      pinned: true,
      content: '所有对外说明保持直白通俗',
    }) as MemoryEntry;

    const updatedEntry = await core.request('memories.save', {
      ...entry,
      content: '所有对外说明保持直白、通俗，少用专业术语',
    }) as MemoryEntry;
    expect(updatedEntry.revision).toBe(2);
    const savedUpdatedAt = updatedEntry.updatedAt;

    core.memory.selectContext({ botId: member.id, conversationId: room.id }, {
      query: '对外说明',
      recordAutoInject: true,
      scopeKey: 'run-1',
    });
    core.memory.query({ botId: member.id, conversationId: room.id }, { query: '对外说明' }, {
      recordActiveRead: true,
      scopeKey: 'run-1',
    });

    const afterUsage = core.state.storage.get<MemoryEntry>('memory_entries', entry.id)!;
    expect(afterUsage.revision).toBe(2);
    expect(afterUsage.updatedAt).toBe(savedUpdatedAt);

    const snapMemory = core.state.snapshot().memories.find(item => item.id === entry.id)!;
    expect(snapMemory.usage).toMatchObject({
      autoInjectedCount: 1,
      activeReadCount: 1,
      lastRecalledAt: expect.any(String),
    });

    const backup = await core.request('backup.create') as { path: string };
    core.memories.revoke(entry.id);
    await core.request('backup.restore', { path: backup.path });

    const restoredSnap = core.state.snapshot().memories.find(item => item.id === entry.id)!;
    expect(restoredSnap.status).toBe('approved');
    expect(restoredSnap.pinned).toBe(true);
    expect(restoredSnap.usage).toMatchObject({
      autoInjectedCount: 1,
      activeReadCount: 1,
      lastRecalledAt: expect.any(String),
    });
    const restoredHistory = await core.request('memories.history', { id: entry.id }) as { revisions: unknown[] };
    expect(restoredHistory.revisions).toHaveLength(1);
  });
});
