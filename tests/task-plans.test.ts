import { describe, expect, it } from 'vitest';
import type { Bot, Task } from '../src/domain/types.js';
import type { TaskPlanInput } from '../src/domain/task-plan.js';
import { taskPlanToolNames } from '../src/domain/tool-permissions.js';
import { State } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

async function arrangedTask() {
  const { core, connection, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test', memoryMode: 'off' } });
  const chief = core.state.settings().mainBotId!, a = bot('A'), b = bot('B'), c = bot('C');
  const source = core.tasks.create({ conversationId: core.state.settings().mainConversationId!, botId: chief, goal: '工作目标' });
  const input: TaskPlanInput = { title: '工作安排', steps: [
    { id: 'prepare', title: '准备资料', kind: 'work', memberIds: [chief], dependencyIds: [] },
    { id: 'parallel', title: '分工完成工作', kind: 'work', memberIds: [a.id, b.id], dependencyIds: ['prepare'] },
    { id: 'follow', title: '核查成果', kind: 'work', memberIds: [c.id], dependencyIds: ['parallel'] },
  ] };
  core.tools.plans.set(source, input);
  const group = core.team.createTaskGroup(source, { name: '工作群', goal: '团队工作', memberIds: [a.id, b.id, c.id] });
  const delegate = (botId: string, planStepId: string) => core.tasks.create({ conversationId: group.conversation.id,
    botId, parentId: group.task.id, goal: planStepId, planStepId });
  return { core, chief, a, b, c, source, input, group, delegate };
}

describe('管家任务安排', () => {
  it('安排只保存分工，完整的前置成员任务转换为现有调度依赖', async () => {
    const { core, a, b, c, source, group, delegate } = await arrangedTask();
    expect(core.state.storage.all<Task>('tasks')).toHaveLength(2);
    expect(core.tools.plans.get(group.task)?.id).toBe(source.id);
    expect(() => delegate(a.id, 'parallel')).toThrow('前置');
    core.tools.plans.update(source, { stepId: 'prepare', status: 'completed' });
    const first = delegate(a.id, 'parallel');
    expect(() => delegate(c.id, 'follow')).toThrow('完整派发');
    const second = delegate(b.id, 'parallel'), follow = delegate(c.id, 'follow');
    expect(first.dependencyIds).toEqual([]);
    expect(second.dependencyIds).toEqual([]);
    expect(follow.dependencyIds).toEqual([first.id, second.id]);
    expect(first).toMatchObject({ planId: source.id, planStepId: 'parallel' });
    expect(() => delegate(c.id, 'parallel')).toThrow('不属于此步骤');
    expect(core.tools.plans.get(source)?.steps[1].taskIds).toEqual([first.id, second.id]);
  });

  it('按实际任务反映完成、失败、重试和停止，不允许管家勾选成员完成', async () => {
    const { core, a, b, source, delegate } = await arrangedTask();
    core.tools.plans.update(source, { stepId: 'prepare', status: 'completed' });
    const first = delegate(a.id, 'parallel');
    core.tasks.update(first, { status: 'completed' });
    expect(core.tools.plans.get(source)?.steps[1].status).not.toBe('completed');
    const second = delegate(b.id, 'parallel');
    core.tasks.update(second, { status: 'failed', error: '实际执行失败' });
    expect(core.tools.plans.get(source)?.steps[1].status).toBe('failed');
    expect(() => core.tools.plans.update(source, { stepId: 'parallel', status: 'completed' })).toThrow('实际任务');
    core.tasks.retry(second.id);
    expect(core.tools.plans.get(source)?.steps[1].status).toBe('queued');
    core.tasks.update(second, { status: 'completed' });
    expect(core.tools.plans.get(source)?.steps[1].status).toBe('completed');
    core.tasks.update(source, { status: 'cancelled' });
    expect(core.tools.plans.get(source)?.steps.map(step => step.status)).toEqual(['completed', 'completed', 'cancelled']);
  });

  it('步骤数量与顺序可按任务调整，保留已开始分工，拒绝循环依赖', async () => {
    const { core, source, input } = await arrangedTask();
    core.tools.plans.update(source, { stepId: 'prepare', status: 'running', note: '正在整理实际资料' });
    const revised = { ...input, steps: [input.steps[0], { ...input.steps[2], dependencyIds: ['prepare'] }] };
    expect(core.tools.plans.set(source, revised).steps.map(step => step.id)).toEqual(['prepare', 'follow']);
    expect(core.tools.plans.get(source)?.steps[0].note).toBe('正在整理实际资料');
    expect(() => core.tools.plans.set(source, { ...revised, steps: [{ ...input.steps[0], memberIds: input.steps[1].memberIds }] }))
      .toThrow('已开始');
    expect(() => core.tools.plans.set(source, { ...revised, steps: [{ ...input.steps[0], dependencyIds: ['follow'] }, revised.steps[1]] }))
      .toThrow('前置步骤');
    core.tools.plans.update(source, { stepId: 'follow', status: 'skipped', note: '用户缩小交付范围' });
    expect(core.tools.plans.get(source)?.steps[1].status).toBe('skipped');
  });

  it('任务间安排独立，普通成员不能读写主管安排，已关闭权限不被再次迁移覆盖', async () => {
    const { core, source, chief, a } = await arrangedTask();
    const next = core.tasks.create({ conversationId: source.conversationId, botId: chief, goal: '另一个工作' });
    expect(core.tools.plans.get(next)).toBeUndefined();
    const memberTask = core.tasks.create({ conversationId: source.conversationId, botId: chief, goal: '工具边界' });
    const privateRoom = core.entities.createConversation({ name: '成员私聊', kind: 'private', memberIds: [a.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const privateTask = core.tasks.create({ conversationId: privateRoom.id, botId: a.id, goal: '成员工作' });
    expect(() => core.tools.plans.get(privateTask)).toThrow('只有管家');
    const owner = core.state.storage.get<Bot>('bots', chief)!;
    core.state.storage.put('bots', { ...owner, toolNames: owner.toolNames.filter(name => !taskPlanToolNames.includes(name)) });
    core.state.storage.setMetadata('chief-task-plans-v1', false);
    core.state.syncMainTeam();
    expect(core.state.storage.get<Bot>('bots', chief)?.toolNames).toEqual(expect.arrayContaining(taskPlanToolNames));
    const upgraded = core.state.storage.get<Bot>('bots', chief)!;
    core.state.storage.put('bots', { ...upgraded, toolNames: upgraded.toolNames.filter(name => name !== 'set_task_plan') });
    core.state.syncMainTeam();
    expect(core.state.storage.get<Bot>('bots', chief)?.toolNames).not.toContain('set_task_plan');
    expect(core.tools.plans.get(memberTask)).toBeUndefined();
  });

  it('普通成员即使声明工具名，也不能通过模型调用取得安排权限', async () => {
    const { core, bot } = await setup(async context => {
      expect(context.tools.some(tool => taskPlanToolNames.includes(tool.name))).toBe(false);
      await expect(context.executeTool('get_task_plan', {}, 'get')).rejects.toThrow('未授权');
      await expect(context.executeTool('set_task_plan', { title: '越权', steps: [] }, 'set')).rejects.toThrow('未授权');
      return { text: '边界已验证' };
    });
    const member = bot('成员', taskPlanToolNames);
    core.state.storage.put('bots', { ...member, toolNames: taskPlanToolNames });
    const room = core.entities.createConversation({ name: '私聊', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '测试' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(core.state.snapshot().taskPlans).toEqual([]);
  });

  it('重启保留同一份任务安排，管家自执行步骤停止后显示实际终态', async () => {
    const { core, source } = await arrangedTask();
    core.tools.plans.update(source, { stepId: 'prepare', status: 'running' });
    core.tasks.update(source, { status: 'interrupted' });
    const reopened = new State(core.state.dataDirectory);
    try {
      expect(reopened.snapshot().taskPlans[0]).toMatchObject({ id: source.id, title: '工作安排' });
      expect(reopened.snapshot().taskPlans[0].steps[0].status).toBe('interrupted');
    } finally { reopened.storage.close(); }
  });
});
