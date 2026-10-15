import { describe, expect, it } from 'vitest';
import type { Connection, Conversation, Task } from '../src/domain/types.js';
import type { TaskPlan } from '../src/domain/task-plan.js';
import { eventually, setup } from './core-harness.js';

describe('团队安排实际执行', () => {
  it('跨主管轮次共享安排，讨论后并行执行，并等待完整前置成果后接续', async () => {
    let a = '', b = '', c = '', mainRounds = 0, groupRounds = 0;
    let group: { conversation: Conversation; task: Task } | undefined;
    const started = new Set<string>();
    let release!: () => void;
    const work = new Promise<void>(resolve => { release = resolve; });
    const { core, connection, bot } = await setup(async context => {
      const chief = core.state.settings().mainBotId!;
      if (context.bot.id !== chief) {
        expect(context.prompt).not.toContain('仅在主对话的私人背景');
        expect(context.prompt).toContain('你参与的安排步骤');
        if (context.prompt.includes('当前任务：讨论目标')) {
          await context.executeTool('post_message', { content: `${context.bot.name} 的真实讨论观点` }, 'discussion');
          return { text: `${context.bot.name} 的讨论结果` };
        }
        if ([a, b].includes(context.bot.id)) {
          started.add(context.bot.id);
          await work;
          return { text: `${context.bot.name} 的实际成果` };
        }
        const plan = core.state.snapshot().taskPlans[0];
        expect(plan.steps.find(step => step.id === 'execute')?.status).toBe('completed');
        started.add(c);
        return { text: 'C 的核查成果' };
      }
      if (context.binding.conversationId === core.state.settings().mainConversationId) {
        if (++mainRounds === 1) {
          expect(context.instructions).toContain('复杂、多阶段或需要成员协作');
          expect(context.tools.some(tool => tool.name === 'set_task_plan')).toBe(true);
          await context.executeTool('set_task_plan', { title: '完成本轮工作', steps: [
            { id: 'prepare', title: '整理需求', kind: 'work', memberIds: [chief], dependencyIds: [] },
            { id: 'discuss', title: '共同提出观点', kind: 'discussion', memberIds: [chief, a, b], dependencyIds: ['prepare'] },
            { id: 'execute', title: '分别制作成果', kind: 'work', memberIds: [a, b], dependencyIds: ['discuss'] },
            { id: 'review', title: '核查成果', kind: 'work', memberIds: [c], dependencyIds: ['execute'] },
            { id: 'deliver', title: '向用户交付', kind: 'work', memberIds: [chief], dependencyIds: ['review'] },
          ] }, 'arrange');
          await context.executeTool('update_plan_step', { stepId: 'prepare', status: 'running' }, 'prepare-start');
          await context.executeTool('update_plan_step', { stepId: 'prepare', status: 'completed' }, 'prepare-finish');
          group = await context.executeTool('create_task_group', { name: '专项协作', goal: '完成团队工作', memberIds: [a, b, c] }, 'group') as typeof group;
          return { text: '已安排协作' };
        }
        expect(context.prompt).toContain('当前任务安排与实际进度');
        const plan = await context.executeTool('get_task_plan', {}, 'plan') as TaskPlan;
        expect(plan.steps.slice(0, 4).every(step => step.status === 'completed')).toBe(true);
        await context.executeTool('update_plan_step', { stepId: 'deliver', status: 'completed' }, 'deliver');
        return { text: '已核查并交付实际成果' };
      }
      const plan = await context.executeTool('get_task_plan', {}, `plan-${++groupRounds}`) as TaskPlan;
      expect(plan.conversationId).toBe(core.state.settings().mainConversationId);
      expect(context.prompt).toContain('当前任务安排与实际进度');
      if (groupRounds === 1) {
        for (const botId of [a, b]) await context.executeTool('delegate_task', {
          botId, goal: '讨论目标', expectedOutput: '讨论观点', planStepId: 'discuss',
        }, `discuss-${botId}`);
        return { text: '请一起讨论' };
      }
      if (groupRounds === 2) {
        expect(plan.steps[1].status).toBe('completed');
        for (const botId of [a, b]) {
          const args = { botId, goal: '制作成果', expectedOutput: '实际文件', planStepId: 'execute' };
          const first = await context.executeTool('delegate_task', args, `execute-${botId}`) as Task;
          const replay = await context.executeTool('delegate_task', args, `replay-${botId}`) as Task;
          expect(replay.id).toBe(first.id);
          expect(first.dependencyIds).toEqual([]);
        }
        const review = await context.executeTool('delegate_task', { botId: c, goal: '核查成果', expectedOutput: '核查结论', planStepId: 'review' }, 'review') as Task;
        expect(review.dependencyIds).toHaveLength(2);
        return { text: '分工制作并安排核查' };
      }
      expect(plan.steps[3].status).toBe('completed');
      return { text: '团队工作已核查' };
    });
    [a, b, c] = ['A', 'B', 'C'].map(name => {
      const member = bot(name, ['post_message']); core.entities.saveBot({ ...member, memoryMode: 'off' }); return member.id;
    });
    core.state.storage.put('connections', { ...core.state.storage.get<Connection>('connections', connection.id)!, concurrency: 4 });
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test', memoryMode: 'off' } });
    const sent = core.tasks.send({ conversationId: core.state.settings().mainConversationId!, content: '仅在主对话的私人背景，请完成工作' });
    try {
      await eventually(() => started.has(a) && started.has(b));
      expect(started.has(c)).toBe(false);
      expect(core.state.snapshot().taskPlans[0].steps[2].status).toBe('running');
      expect(core.state.snapshot().tasks.find(task => task.planStepId === 'review')?.queueReason).toBe('dependencies');
    } finally { release(); }
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(started.has(c)).toBe(true);
    expect(mainRounds).toBe(2); expect(groupRounds).toBe(3);
    expect(core.state.snapshot().taskPlans[0].steps.every(step => step.status === 'completed')).toBe(true);
    expect(core.state.storage.all<Task>('tasks').filter(task => task.planStepId === 'execute')).toHaveLength(2);
    expect(core.state.storage.messages(group!.conversation.id).filter(message => message.content.includes('真实讨论观点'))).toHaveLength(2);
  });
});
