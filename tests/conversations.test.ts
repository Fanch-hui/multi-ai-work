import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Conversation, SessionBinding, Task } from '../src/domain/types.js';
import { ConversationService } from '../src/core/conversations.js';
import { eventually, setup } from './core-harness.js';

describe('会话管理', () => {
  it.each(['archive', 'members'] as const)(
    '%s 等待任务退出时保留并发保存的新名称',
    async (action) => {
      let release!: () => void,
        cancelling = false;
      const { core, bot } = await setup(async (context) => {
        await new Promise<void>((resolve) => {
          release = resolve;
          context.signal.addEventListener(
            'abort',
            () => {
              cancelling = true;
            },
            { once: true },
          );
        });
        return { text: '已结束' };
      });
      const member = bot('成员'),
        chiefId = core.state.settings().mainBotId!;
      const room = core.entities.createConversation({
        name: '原名称',
        kind: 'group',
        chiefId,
        memberIds: [chiefId, member.id],
        workspaceId: core.state.snapshot().workspaces[0].id,
      });
      core.tasks.send({ conversationId: room.id, content: '等待停止', targetBotIds: [member.id] });
      await eventually(() => !!release);
      const conversations = new ConversationService(core.state, core.tasks, core.scheduler);
      const operation =
        action === 'archive'
          ? conversations.archive(room.id, true)
          : conversations.updateMembers(room.id, []);
      await eventually(() => cancelling);
      conversations.rename(room.id, '用户保存的新名称');
      release();
      const updated = await operation;
      expect(updated).toMatchObject({ id: room.id, name: '用户保存的新名称', nameEdited: true });
      expect(core.state.storage.get<Conversation>('conversations', room.id)?.name).toBe(
        '用户保存的新名称',
      );
      if (action === 'archive') expect(updated.archived).toBe(true);
      else expect(updated.memberIds).toEqual([chiefId]);
    },
  );

  it('归档历史工作会等待活动任务停止，首页保持稳定，恢复后可继续发送', async () => {
    const { core, connection } = await setup(async (context) => {
      await new Promise((_, reject) =>
        context.signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }),
      );
      return { text: '不应完成' };
    });
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const homeId = core.state.settings().mainConversationId!;
    const roomId = core.team.createChiefExecutionConversation('历史事项', {
      chiefRole: 'work',
    }).id;
    const sent = core.tasks.send({ conversationId: roomId, content: '等待取消' });
    await eventually(() => core.state.snapshot().runs.some((run) => run.status === 'running'));
    const conversations = new ConversationService(core.state, core.tasks, core.scheduler);
    const operation = conversations.archive(roomId, true);
    expect(() => core.tasks.send({ conversationId: roomId, content: '取消期间' })).toThrow(
      '归档或正在修改',
    );
    const archived = await operation;
    expect(archived.archived).toBe(true);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status).toBe('cancelled');
    expect(core.state.snapshot().runs[0].status).toBe('cancelled');
    const nextId = core.state.settings().mainConversationId!;
    expect(nextId).toBe(homeId);
    expect(core.state.storage.get<Conversation>('conversations', nextId)?.archived).not.toBe(true);
    expect(() => core.tasks.send({ conversationId: roomId, content: '归档后发送' })).toThrow(
      '归档',
    );
    await conversations.archive(roomId, false);
    core.scheduler.pause();
    expect(core.tasks.send({ conversationId: roomId, content: '恢复后发送' }).taskIds).toHaveLength(
      1,
    );
  });

  it('删除清理会话与执行记录，成果字节和其他会话保持完整', async () => {
    const { core, bot } = await setup(async (context) => {
      await context.executeTool(
        'write_artifact',
        { path: 'retained.md', format: 'markdown', content: '成果保留' },
        'artifact',
      );
      return { text: '完成' };
    });
    const member = bot('作者', ['write_artifact']);
    const room = core.entities.createConversation({
      name: '待删除',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const other = core.entities.createConversation({
      name: '保留会话',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: room.workspaceId,
    });
    core.tasks.post(other.id, member.id, 'historic', '原有消息');
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '生成成果',
      requestId: 'deleted-send',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    const artifact = core.state.snapshot().artifacts[0];
    const binding = core.state.storage.all<SessionBinding>('session_bindings')[0];
    const run = core.state.snapshot().runs[0];
    core.state.storage.setMetadata(`history:${binding.id}`, [
      { role: 'user', content: '待删除历史' },
    ]);
    core.state.storage.setMetadata(`history-validity:${binding.id}`, {
      signature: 'old',
      sourceIds: ['source'],
    });
    core.state.storage.put('context_checkpoints', { id: 'checkpoint', bindingId: binding.id });
    core.state.storage.put('compactions', { id: 'compaction', bindingId: binding.id });
    core.state.storage.put('provider_archive', { id: run.id, bindingId: binding.id });
    core.state.storage.put('managed_progress_deltas', { id: 'delta', runId: run.id });
    core.state.storage.put('managed_progress_deltas', { id: 'retained-delta', runId: 'other-run' });
    await new ConversationService(core.state, core.tasks, core.scheduler).delete(room.id);
    const snapshot = core.state.snapshot();
    expect(snapshot.conversations.find((item) => item.id === room.id)).toBeUndefined();
    expect(snapshot.messages.filter((item) => item.conversationId === room.id)).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.bindings).toEqual([]);
    expect(snapshot.checkpoints).toEqual([]);
    expect(snapshot.compactions).toEqual([]);
    expect(core.state.storage.all('provider_archive')).toEqual([]);
    expect(core.state.storage.all('managed_progress_deltas')).toEqual([
      { id: 'retained-delta', runId: 'other-run' },
    ]);
    expect(core.state.storage.all('tool_operations')).toEqual([]);
    expect(core.state.storage.metadata('send:deleted-send')).toBeUndefined();
    expect(core.state.storage.metadata(`history:${binding.id}`)).toBeUndefined();
    expect(core.state.storage.metadata(`history-validity:${binding.id}`)).toBeUndefined();
    expect(snapshot.artifacts).toEqual([artifact]);
    expect(await readFile(artifact.path, 'utf8')).toBe('成果保留');
    expect(core.state.storage.get('conversations', other.id)).toEqual(other);
    expect(core.state.storage.messages(other.id)[0].content).toBe('原有消息');
  });

  it('移除群成员停止其任务，保留发言，管家留群，所有人仅派发有效成员', async () => {
    const { core, connection, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const chiefId = core.state.settings().mainBotId!;
    const member = bot('离开成员'),
      staying = bot('留下成员');
    const room = core.entities.createConversation({
      name: '成员管理',
      kind: 'group',
      chiefId,
      memberIds: [chiefId, member.id, staying.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    core.tasks.post(room.id, member.id, 'old-run', '离开前的讨论');
    const pending = core.tasks.create({
      conversationId: room.id,
      botId: member.id,
      goal: '尚未启动',
    });
    const saved = await new ConversationService(
      core.state,
      core.tasks,
      core.scheduler,
    ).updateMembers(room.id, [staying.id]);
    expect(saved.memberIds).toEqual([chiefId, staying.id]);
    expect(core.state.storage.get<Task>('tasks', pending.id)?.status).toBe('cancelled');
    expect(core.state.storage.messages(room.id)[0].content).toBe('离开前的讨论');
    expect(() => core.tasks.retry(pending.id)).toThrow('有效成员');
    expect(() =>
      core.tasks.create({
        conversationId: room.id,
        botId: member.id,
        goal: pending.goal,
        requestId: pending.requestId,
      }),
    ).toThrow('有效成员');
    expect(() =>
      core.tasks.send({ conversationId: room.id, content: '越权', targetBotIds: [member.id] }),
    ).toThrow('有效成员');
    const all = core.tasks.send({
      conversationId: room.id,
      content: '@所有人 继续讨论',
      targetBotIds: saved.memberIds,
    });
    expect(
      all.taskIds.map((taskId) => core.state.storage.get<Task>('tasks', taskId)?.botId),
    ).toEqual([chiefId, staying.id]);
  });

  it('删除历史工作会话保留独立群与群历史，解除跨会话指针', async () => {
    const { core, connection, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const homeId = core.state.settings().mainConversationId!;
    const work = core.team.createChiefExecutionConversation('历史工作', { chiefRole: 'work' });
    const source = core.tasks.create({
      conversationId: work.id,
      botId: core.state.settings().mainBotId!,
      goal: '主任务',
    });
    const group = core.team.createTaskGroup(source, {
      name: '独立群',
      goal: '公开目标',
      memberIds: [bot('成员').id],
    });
    core.tasks.post(group.conversation.id, source.botId, 'history', '群内历史');
    await new ConversationService(core.state, core.tasks, core.scheduler).delete(
      source.conversationId,
    );
    expect(core.state.storage.get('tasks', source.id)).toBeUndefined();
    const task = core.state.storage.get<Task>('tasks', group.task.id)!;
    expect(task.parentId).toBeUndefined();
    expect(task.status).toBe('cancelled');
    const room = core.state.storage.get<Conversation>('conversations', group.conversation.id)!;
    expect(room.sourceConversationId).toBeUndefined();
    expect(room.sourceTaskId).toBeUndefined();
    expect(core.state.storage.messages(room.id)[0].content).toBe('群内历史');
    expect(core.state.settings().mainConversationId).toBe(homeId);
  });
});
