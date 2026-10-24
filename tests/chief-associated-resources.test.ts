import { describe, expect, it } from 'vitest';
import type { Conversation, Task } from '../src/domain/types.js';
import { setup } from './core-harness.js';

describe('管家关联资源', () => {
  it('主入口能引用后台建立的群并查看协作，普通成员私聊保持原范围', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const chief = bot('Chief');
    const member = bot('成员');
    const work = core.chief.contexts.create({ kind: 'work', title: '报告' });
    const source = core.tasks.create({
      conversationId: work.conversationId,
      botId: chief.id,
      goal: '报告',
    });
    const group = core.team.createTaskGroup(source, {
      name: '报告群',
      goal: '检查报告',
      memberIds: [member.id],
    });
    const privateRoom = core.entities.createConversation({
      name: '成员私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.settings().defaultWorkspaceId!,
    });
    for (const [id, conversationId] of [
      ['owned', group.conversation.id],
      ['private', privateRoom.id],
    ]) {
      core.state.storage.put('collaboration_requests', { id, conversationId, status: 'requested' });
    }
    const home = core.state.settings().mainConversationId!;
    const main = core.chief.contexts.main().room.id;
    for (const id of [home, main]) {
      const options = (await core.request('conversations.references', { conversationId: id })) as {
        kind: string;
        id: string;
      }[];
      expect(options).toContainEqual(
        expect.objectContaining({ kind: 'conversation', id: group.conversation.id }),
      );
      const requests = (await core.request('collaboration.list', { conversationId: id })) as {
        id: string;
      }[];
      expect(requests.map((item) => item.id)).toEqual(['owned']);
    }
    const requests = (await core.request('collaboration.list', {
      conversationId: privateRoom.id,
    })) as { id: string }[];
    expect(requests.map((item) => item.id)).toEqual(['private']);
    const sourceRoom = core.state.storage.get<Conversation>('conversations', main)!;
    const mainTask = core.tasks.create({
      conversationId: sourceRoom.id,
      botId: chief.id,
      goal: '主对话',
    });
    expect(() =>
      core.team.createTaskGroup(mainTask, { name: '任务', goal: '制作', memberIds: [member.id] }),
    ).toThrow('start_work');
    expect(core.state.storage.get<Task>('tasks', source.id)?.status).toBe('queued');
  });
});
