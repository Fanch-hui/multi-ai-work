import { describe, expect, it } from 'vitest';
import type { Routine, RoutineOccurrence } from '../src/domain/routines.js';
import type { Task } from '../src/domain/types.js';
import { scopedTask } from '../src/core/task-access.js';
import { eventually, setup } from './core-harness.js';

async function fixture() {
  const { core, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const chief = core.entities.saveBot({ ...bot('Chief'), approvalMode: 'auto', memoryMode: 'off' });
  const member = bot('每日助理');
  const main = core.chief.contexts.main();
  const foreground = core.tasks.create({
    conversationId: main.room.id,
    botId: chief.id,
    goal: '主对话交流',
  });
  const routine = (await core.routines.request('routines.save', {
    input: {
      name: '每日摘要',
      botId: member.id,
      workspaceId: main.room.workspaceId,
      goal: '整理每日摘要',
      expectedOutput: '简短摘要',
      inputArtifactIds: [],
      schedule: { kind: 'daily', time: '09:00' },
      timeZone: 'UTC',
      enabled: false,
      missedRunPolicy: 'latest',
    },
  })) as Routine;
  const occurrence = core.routines.request('routines.runNow', {
    id: routine.id,
    requestId: 'acceptance',
  }) as RoutineOccurrence;
  const task = core.state.storage.get<Task>('tasks', occurrence.taskId!)!;
  return { core, chief, member, main, foreground, routine, occurrence, task };
}

describe('例行工作回报与主管控制范围', () => {
  it('成员例行工作通过真实执行记录回报主对话，重复通知只汇报一次', async () => {
    const f = await fixture();
    f.core.tasks.update(f.task, { status: 'completed', result: '每日摘要已完成' });
    f.core.tasks.update(f.foreground, { status: 'completed' });
    await eventually(
      () =>
        f.core.state.storage.byField<Task>('tasks', 'conversationId', f.main.room.id).length === 2,
    );
    const report = f.core.state.storage
      .byField<Task>('tasks', 'conversationId', f.main.room.id)
      .at(-1)!;
    expect(report.goal).toContain('每日摘要已完成');
    expect(report.goal).toContain(f.routine.id);
    expect(report.goal).toContain('manage_routines');
    const saved = f.core.state.storage.metadata<{ taskId: string; deliveredAt?: string }[]>(
      `chief-work-reports:${f.main.context.homeConversationId}`,
    )!;
    expect(saved.filter((item) => item.taskId === f.task.id)).toHaveLength(1);
    expect(saved[0].deliveredAt).toBeTruthy();
  });

  it('只有例行工作及其真实触发任务可由主对话控制，普通私聊保持原范围', async () => {
    const f = await fixture();
    expect(scopedTask(f.core.state, f.main.room, f.chief.id, f.task.id)?.id).toBe(f.task.id);
    const ordinary = f.core.entities.createConversation({
      name: '成员私聊',
      kind: 'private',
      memberIds: [f.member.id],
      workspaceId: f.main.room.workspaceId,
    });
    const unrelated = f.core.tasks.create({
      conversationId: ordinary.id,
      botId: f.member.id,
      goal: '私聊内容',
    });
    expect(scopedTask(f.core.state, f.main.room, f.chief.id, unrelated.id)).toBeUndefined();
    const forged = f.core.tasks.create({
      conversationId: ordinary.id,
      botId: f.member.id,
      goal: '另一任务',
      trigger: f.task.trigger,
    });
    expect(scopedTask(f.core.state, f.main.room, f.chief.id, forged.id)).toBeUndefined();
  });
});
