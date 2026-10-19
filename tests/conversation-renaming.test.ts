import { describe, expect, it } from 'vitest';
import type { Conversation, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('会话名称', () => {
  it('主对话、群聊、成员私聊和归档会话均可修改名称', async () => {
    const { core, connection, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const chiefRoom = core.state.storage.get<Conversation>(
      'conversations',
      core.state.settings().mainConversationId!,
    )!;
    const member = bot('成员');
    const privateRoom = core.entities.createConversation({
      name: '成员私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: chiefRoom.workspaceId,
    });
    const group = core.entities.createConversation({
      name: '任务群',
      kind: 'group',
      chiefId: chiefRoom.chiefId,
      memberIds: [chiefRoom.chiefId!, member.id],
      workspaceId: chiefRoom.workspaceId,
    });
    const archived = { ...privateRoom, id: 'archived-room', archived: true };
    core.state.storage.put('conversations', archived);
    for (const room of [chiefRoom, privateRoom, group, archived]) {
      const renamed = (await core.request('conversations.rename', {
        id: room.id,
        name: '  我的会话  ',
      })) as Conversation;
      expect(renamed).toEqual({ ...room, name: '我的会话', nameEdited: true });
      expect(core.state.storage.get('conversations', room.id)).toEqual(renamed);
    }
    expect(() => core.conversations.rename(chiefRoom.id, '  ')).toThrow('不能为空');
    expect(() => core.conversations.rename(chiefRoom.id, '长'.repeat(121))).toThrow('最多');
    expect(() => core.conversations.rename('missing', '名称')).toThrow('不存在');
  });

  it('修改名称保留正在运行的任务、消息、上下文与会话绑定', async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { core, bot } = await setup(async () => {
      await ready;
      return { text: '完成' };
    });
    const member = bot('成员');
    const room = core.entities.createConversation({
      name: '原名称',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '继续执行' });
    await eventually(() => core.state.snapshot().runs.some((run) => run.status === 'running'));
    const before = core.state.snapshot();
    core.conversations.rename(room.id, '新名称');
    const after = core.state.snapshot();
    expect(after.tasks).toEqual(before.tasks);
    expect(after.runs).toEqual(before.runs);
    expect(after.bindings).toEqual(before.bindings);
    expect(after.messages).toEqual(before.messages);
    expect(after.checkpoints).toEqual(before.checkpoints);
    finish();
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.get<Conversation>('conversations', room.id)?.name).toBe('新名称');
  });

  it('用户保存的名称不被首条消息自动命名覆盖', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const roomId = core.state.settings().mainConversationId!;
    core.conversations.rename(roomId, '新对话');
    core.tasks.send({ conversationId: roomId, content: '不会成为会话名称' });
    expect(core.state.storage.get<Conversation>('conversations', roomId)?.name).toBe('新对话');
  });
});
