import { describe, expect, it } from 'vitest';
import type { Bot, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('主管自动跟进', () => {
  it('默认不限，主管可持续组织成员直到任务完成', async () => {
    let member!: Bot,
      chiefRuns = 0;
    const { core, bot } = await setup(async (context) => {
      if (context.bot.id === member.id) return { text: `成果：${context.prompt}` };
      chiefRuns++;
      if (chiefRuns <= 13) {
        await context.executeTool(
          'delegate_task',
          { botId: member.id, goal: `补充 ${chiefRuns}`, expectedOutput: '结果' },
          `delegate-${chiefRuns}`,
        );
        return { text: '等待补充结果' };
      }
      return { text: '所有补充任务完成' };
    });
    await core.request('settings.save', { input: { maxChildren: 30 } });
    const chief = core.entities.saveBot({ ...bot('Chief', ['delegate_task']), memoryMode: 'off' });
    member = core.entities.saveBot({ ...bot('成员'), memoryMode: 'off' });
    const room = core.entities.createConversation({
      name: '跟进',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '反复补充后完成',
      targetBotIds: [chief.id],
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(chiefRuns).toBe(14);
    expect(core.state.storage.metadata(`coordination:${sent.taskIds[0]}`)).toBe(13);
    expect(
      core.state.snapshot().tasks.filter((task) => task.parentId === sent.taskIds[0]),
    ).toHaveLength(13);
  });
  it.each(['直接继续', '取消后重试'])('达到上限后%s保留任务 ID 与最新成员成果', async (action) => {
    let member!: Bot,
      chiefRuns = 0;
    const { core, bot } = await setup(async (context) => {
      if (context.bot.id === member.id)
        return { text: chiefRuns === 1 ? '第一份成果' : '第二份成果' };
      chiefRuns++;
      if (chiefRuns <= 2) {
        await context.executeTool(
          'delegate_task',
          { botId: member.id, goal: `补充 ${chiefRuns}`, expectedOutput: '结果' },
          `delegate-${chiefRuns}`,
        );
        return { text: '等待补充结果' };
      }
      expect(context.prompt).toContain('第二份成果');
      return { text: '汇总完成' };
    });
    await core.request('settings.save', { input: { maxCoordinationRounds: 1 } });
    const chief = core.entities.saveBot({ ...bot('Chief', ['delegate_task']), memoryMode: 'off' });
    member = core.entities.saveBot({ ...bot('成员'), memoryMode: 'off' });
    const room = core.entities.createConversation({
      name: '跟进',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '完成工作',
      targetBotIds: [chief.id],
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.coordinationPaused === true,
    );
    expect(chiefRuns).toBe(2);
    if (action === '取消后重试') await core.request('tasks.cancel', { id: sent.taskIds[0] });
    expect(core.tasks.retry(sent.taskIds[0])).toMatchObject({
      id: sent.taskIds[0],
      coordinationPaused: false,
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(chiefRuns).toBe(3);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.coordinationPaused).toBe(false);
  });
});
