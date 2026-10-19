import { describe, expect, it } from 'vitest';
import type { Bot, MemoryEntry, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('智能体自主管理记忆', () => {
  it('成员跨会话管理自己的记忆，检索和自动注入仍限获授权会话', async () => {
    let memoryId = '';
    const { core, bot } = await setup(async (context) => {
      expect(context.instructions).not.toContain('仅供会话甲使用的长期约定');
      expect(context.runtimeContext?.content).not.toContain('仅供会话甲使用的长期约定');
      expect(await context.executeTool('recall_memory', { query: '长期约定' }, 'recall')).toEqual(
        [],
      );
      expect(await context.executeTool('manage_memory', { action: 'list' }, 'list')).toEqual([
        expect.objectContaining({ id: memoryId, content: '仅供会话甲使用的长期约定' }),
      ]);
      const entry = (await context.executeTool(
        'manage_memory',
        { action: 'list', id: memoryId },
        'read',
      )) as MemoryEntry;
      const updated = (await context.executeTool(
        'manage_memory',
        { action: 'save', id: memoryId, content: '仅供会话甲使用的长期约定，已修订' },
        'edit',
      )) as MemoryEntry;
      expect(updated.allowedConversationIds).toEqual(entry.allowedConversationIds);
      expect(
        await context.executeTool('recall_memory', { query: '长期约定' }, 'recall-after-edit'),
      ).toEqual([]);
      await context.executeTool('manage_memory', { action: 'revoke', id: memoryId }, 'revoke');
      return { text: '完成管理' };
    });
    const member = bot('成员', ['recall_memory']);
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const roomA = core.entities.createConversation({
      name: '会话甲',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const roomB = core.entities.createConversation({
      name: '会话乙',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    memoryId = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [roomA.id],
      content: '仅供会话甲使用的长期约定',
    }).id;
    const sent = core.tasks.send({ conversationId: roomB.id, content: '管理我的既有记忆' });
    await eventually(() =>
      ['completed', 'failed'].includes(
        core.state.storage.get<Task>('tasks', sent.taskIds[0])!.status,
      ),
    );
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({
      status: 'completed',
    });
    expect(core.state.storage.get<MemoryEntry>('memory_entries', memoryId)).toMatchObject({
      status: 'revoked',
      allowedConversationIds: [roomA.id],
      content: '仅供会话甲使用的长期约定，已修订',
    });
  });

  it('实际保存、回忆和更新自己的记忆，无需用户审批', async () => {
    let savedId = '';
    const { core, bot } = await setup(async (context) => {
      const sourceIds = [context.prompt.match(/\[([\w-]+)\] 用户：/)![1]];
      if (context.prompt.includes('保存约定')) {
        const saved = (await context.executeTool(
          'manage_memory',
          { action: 'save', content: '文档标题使用中文', sourceIds },
          'save-own',
        )) as MemoryEntry;
        savedId = saved.id;
      } else {
        expect(context.instructions).not.toContain('文档标题使用中文');
        expect(context.runtimeContext).toMatchObject({
          role: 'user',
          appContext: { source: 'app.runtime', version: expect.any(String) },
        });
        const current = JSON.parse(context.runtimeContext!.content.split('\n').at(-1)!);
        expect(current.memories).toEqual([
          { source: 'memory_entries', id: savedId, revision: 1, content: '文档标题使用中文' },
        ]);
        expect(await context.executeTool('recall_memory', { query: '标题' }, 'recall-own')).toEqual(
          [expect.objectContaining({ id: savedId, revision: 1, content: '文档标题使用中文' })],
        );
        await context.executeTool(
          'manage_memory',
          { action: 'save', id: savedId, content: '文档标题使用简洁中文', sourceIds },
          'edit-own',
        );
      }
      return { text: '记住了' };
    });
    const member = bot('写作助手', ['recall_memory']);
    const room = core.entities.createConversation({
      name: '写作',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const first = core.tasks.send({
      conversationId: room.id,
      content: '保存约定：以后文档标题使用中文',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', first.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.get<MemoryEntry>('memory_entries', savedId)).toMatchObject({
      status: 'approved',
      ownerId: member.id,
      scope: 'bot',
    });
    expect(core.state.snapshot().approvals).toEqual([]);
    const bindingId = core.state.snapshot().bindings[0].id;
    const second = core.tasks.send({
      conversationId: room.id,
      content: '更新约定：以后文档标题使用简洁中文',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', second.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.get<MemoryEntry>('memory_entries', savedId)?.content).toBe(
      '文档标题使用简洁中文',
    );
    expect(core.state.snapshot().bindings).toHaveLength(1);
    expect(core.state.snapshot().bindings[0].id).toBe(bindingId);
  });

  it('不能查看、夺取或修改其他成员记忆', async () => {
    let otherMemoryId = '';
    const { core, bot } = await setup(async (context) => {
      expect(await context.executeTool('manage_memory', { action: 'list' }, 'list-own')).toEqual(
        [],
      );
      const read = (await context.executeTool(
        'manage_memory',
        { action: 'list', id: otherMemoryId },
        'read-other',
      )) as { error: string };
      expect(read.error).toContain('只能管理自己的记忆');
      const edit = (await context.executeTool(
        'manage_memory',
        { action: 'save', id: otherMemoryId, ownerId: context.bot.id, content: '夺取记忆' },
        'edit-other',
      )) as { error: string };
      expect(edit.error).toContain('只能管理自己的记忆');
      return { text: '完成' };
    });
    const a = bot('甲'),
      b = bot('乙');
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const roomA = core.entities.createConversation({
      name: '甲私聊',
      kind: 'private',
      memberIds: [a.id],
      workspaceId,
    });
    const roomB = core.entities.createConversation({
      name: '乙私聊',
      kind: 'private',
      memberIds: [b.id],
      workspaceId,
    });
    const memory = (await core.request('memories.save', {
      content: '乙的约定',
      scope: 'bot',
      ownerId: b.id,
      allowedConversationIds: [roomB.id],
    })) as MemoryEntry;
    otherMemoryId = memory.id;
    const sent = core.tasks.send({ conversationId: roomA.id, content: '检查记忆范围' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.get<MemoryEntry>('memory_entries', memory.id)).toEqual(memory);
  });

  it('成员不能把自己的群聊讨论作为用户偏好来源', async () => {
    const { core, bot } = await setup(async (context) => {
      expect(context.instructions).toContain('群聊任务目标、预算、日期、进度');
      const discussionId = await context.executeTool(
        'post_message',
        { content: '本次活动预算260元' },
        'discussion',
      );
      const result = (await context.executeTool(
        'propose_memory',
        {
          content: '用户长期预算260元',
          scope: 'bot',
          sourceIds: [
            typeof discussionId === 'string'
              ? discussionId
              : (discussionId as { messageId: string }).messageId,
          ],
        },
        'propose',
      )) as { error: string };
      expect(result.error).toContain('用户消息');
      return { text: '完成' };
    });
    const chief = bot('Chief'),
      member = bot('成员', ['post_message', 'propose_memory']);
    const room = core.entities.createConversation({
      name: '任务群',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '筹备本次活动',
      targetBotIds: [member.id],
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.all('memory_entries')).toEqual([]);
  });

  it('管家后台整理公共候选，独立绑定且不发布用户聊天消息', async () => {
    const { core, bot, connection } = await setup(async (context) => {
      if (context.prompt.includes('整理长期记忆')) {
        expect(context.binding.purpose).toBe('memory');
        expect(context.tools.map((tool) => tool.name)).toEqual(['manage_memory']);
        const memoryId = context.prompt.match(/记忆 ([\w-]+)/)![1];
        const entry = (await context.executeTool(
          'manage_memory',
          { action: 'list', id: memoryId },
          'read-candidate',
        )) as MemoryEntry;
        expect(entry.content).toBe('团队成果采用 Markdown');
        await context.executeTool(
          'manage_memory',
          { action: 'approve', id: memoryId },
          'save-candidate',
        );
        context.emit({ type: 'text', data: { delta: '整理完成' } });
      } else expect(context.binding.purpose).toBeUndefined();
      return { text: '完成' };
    });
    const snapshot = core.state.snapshot();
    const chief = (await core.request('chief.configure', {
      input: {
        ...snapshot.bots.find((item) => item.id === snapshot.settings.mainBotId)!,
        connectionId: connection.id,
        model: 'test',
      },
    })) as Bot;
    const member = bot('成员');
    const group = core.entities.createConversation({
      name: '协作',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, member.id],
      workspaceId: snapshot.workspaces[0].id,
    });
    const candidate = (await core.request('memories.propose', {
      content: '团队成果采用 Markdown',
      scope: 'team',
      ownerId: group.id,
      allowedConversationIds: [group.id],
    })) as MemoryEntry;
    await eventually(
      () =>
        core.state.storage.get<MemoryEntry>('memory_entries', candidate.id)?.status === 'approved',
    );
    await eventually(() =>
      core.state
        .snapshot()
        .tasks.some((task) => task.kind === 'memory-review' && task.status === 'completed'),
    );
    expect(core.state.storage.messages()).toEqual([]);
    const sent = core.tasks.send({
      conversationId: snapshot.settings.mainConversationId!,
      content: '你好',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.snapshot().bindings.map((binding) => binding.purpose)).toContain(undefined);
    expect(core.state.storage.messages()).toHaveLength(2);
  });
});
