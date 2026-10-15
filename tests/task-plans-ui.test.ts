import { describe, expect, it } from 'vitest';
import type { Conversation, Task } from '../src/domain/types.js';
import type { PlanStep, TaskPlan } from '../src/domain/task-plan.js';
import { conversationTaskPlans, currentTaskPlan, planDependencies, planProgress, planStepStatus } from '../apps/ui/src/task-plans.js';

const time = '2026-10-13T10:00:00Z';
const room = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id, name: id, kind: 'group', memberIds: [], workspaceId: 'workspace', createdAt: time, ...extra,
});
const task = (id: string, status: Task['status']): Task => ({
  id, conversationId: 'main', botId: 'chief', dependencyIds: [], goal: id, expectedOutput: '', status,
  runIds: [], artifactIds: [], requestId: id, depth: 0, createdAt: time, updatedAt: time,
});
const step = (id: string, extra: Partial<PlanStep> = {}): PlanStep => ({
  id, title: id, kind: 'work', memberIds: ['chief'], dependencyIds: [], status: 'pending',
  taskIds: [], conversationIds: [], ...extra,
});
const plan = (id: string, taskId: string, extra: Partial<TaskPlan> = {}): TaskPlan => ({
  id, taskId, conversationId: 'main', title: id, steps: [step('first')], createdAt: time, updatedAt: time, ...extra,
});

describe('task arrangement display', () => {
  it('shows the shared source plan only in its explicitly linked task group', () => {
    const source = plan('source', 'root');
    const local = plan('local', 'local-root', { conversationId: 'group' });
    const data = { taskPlans: [source, local, plan('other', 'other-root', { conversationId: 'other' })], tasks: [] };
    expect(conversationTaskPlans(data, room('main')).map(item => item.id)).toEqual(['source']);
    expect(conversationTaskPlans(data, room('group', { purpose: 'task', sourceTaskId: 'root' })).map(item => item.id)).toEqual(['local', 'source']);
    expect(conversationTaskPlans(data, room('private', { sourceTaskId: 'root' }))).toEqual([]);
    expect(conversationTaskPlans({ tasks: [], taskPlans: undefined as never }, room('main'))).toEqual([]);
  });

  it('prioritizes an active arrangement and returns to the most recent one when its task ends', () => {
    const active = plan('active', 'active-task');
    const recent = plan('recent', 'recent-task', { createdAt: '2026-10-13T11:00:00Z' });
    const data = { taskPlans: [active, recent], tasks: [task('active-task', 'waiting_children'), task('recent-task', 'completed')] };
    expect(currentTaskPlan(data, room('main'))?.id).toBe('active');
    data.tasks[0] = task('active-task', 'completed');
    expect(currentTaskPlan(data, room('main'))?.id).toBe('recent');
    expect(currentTaskPlan({ taskPlans: [], tasks: [] }, room('main'))).toBeUndefined();
  });

  it('maps real queue reasons and step dependencies while counting completion separately from skips', () => {
    const queued = step('parallel', { memberIds: ['a', 'b'], status: 'queued', taskIds: ['a-task', 'b-task'], dependencyIds: ['prepare', 'discussion'] });
    const arrangement = plan('arrangement', 'root', { steps: [step('prepare', { status: 'completed' }),
      step('discussion', { kind: 'discussion', status: 'skipped' }), queued] });
    expect(planDependencies(arrangement, queued)).toBe('第 1 步、第 2 步');
    expect(planProgress(arrangement)).toBe('1/3 步完成 · 1 步跳过');
    const data = { tasks: [{ ...task('a-task', 'queued'), queueReason: 'dependencies' as const },
      { ...task('b-task', 'queued'), queueReason: 'account_limit' as const }], processes: [] };
    expect(planStepStatus(queued, data)).toBe('等待前置任务 · 等待连接空闲');
    expect(planStepStatus({ ...queued, status: 'failed' }, data)).toBe('失败');
    expect(planStepStatus({ ...queued, status: 'cancelled' }, data)).toBe('已停止');
  });
});
