import { describe, expect, it } from 'vitest';
import type { Connection, Task } from '../src/domain/types.js';
import type { TaskPlanInput } from '../src/domain/task-plan.js';
import { eventually, setup } from './core-harness.js';

describe('执行期间调整任务安排', () => {
  it('将三位成员串行改为并行后立即调度原排队任务', async () => {
    const started = new Set<string>();
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, connection, bot } = await setup(async (context) => {
      if (context.bot.id === core.state.settings().mainBotId) return { text: '汇总完成' };
      started.add(context.bot.id);
      await work;
      return { text: '成员实际成果' };
    });
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', memoryMode: 'off' },
    });
    core.state.storage.put('connections', {
      ...core.state.storage.get<Connection>('connections', connection.id)!,
      concurrency: 4,
    });
    const members = ['事实梳理', '法律分析', '服务方案'].map((name) => bot(name));
    const chief = core.state.settings().mainBotId!;
    const source = core.tasks.create({
      conversationId: core.state.settings().mainConversationId!,
      botId: chief,
      goal: '团队处理资料，管家汇总交付',
    });
    const input: TaskPlanInput = {
      title: '团队安排',
      steps: members.map((member, index) => ({
        id: `step-${index}`,
        title: member.name,
        kind: 'work',
        memberIds: [member.id],
        dependencyIds: index ? [`step-${index - 1}`] : [],
      })),
    };
    core.tools.plans.set(source, input);
    const group = core.team.createTaskGroup(source, {
      name: '团队工作',
      goal: source.goal,
      memberIds: members.map((member) => member.id),
    });
    const delegated = members.map((member, index) =>
      core.tasks.create({
        conversationId: group.conversation.id,
        botId: member.id,
        parentId: group.task.id,
        goal: member.name,
        planStepId: `step-${index}`,
      }),
    );
    core.tasks.update(source, { status: 'waiting_children' });
    core.tasks.update(group.task, { status: 'waiting_children' });
    core.scheduler.resume();
    try {
      await eventually(() => started.has(members[0].id));
      expect(started.size).toBe(1);
      expect(
        core.state.snapshot().tasks.find((task) => task.id === delegated[1].id)?.queueReason,
      ).toBe('dependencies');
      core.tools.plans.set(source, {
        ...input,
        steps: input.steps.map((step) => ({ ...step, dependencyIds: [] })),
      });
      await eventually(() => started.size === 3);
      expect(
        delegated.map((task) => core.state.storage.get<Task>('tasks', task.id)?.dependencyIds),
      ).toEqual([[], [], []]);
      expect(core.tools.plans.get(source)?.steps.map((step) => step.status)).toEqual([
        'running',
        'running',
        'running',
      ]);
    } finally {
      release();
    }
    await eventually(() =>
      delegated.every(
        (task) => core.state.storage.get<Task>('tasks', task.id)?.status === 'completed',
      ),
    );
  });
});
