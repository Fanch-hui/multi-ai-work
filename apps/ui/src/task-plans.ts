import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import type { PlanStep, TaskPlan } from '../../../src/domain/task-plan.js';
import { recordTaskActive, taskRecordStatus } from './conversation-records.js';
import { chiefConversationIds, isChiefHome } from './chief-work.js';

type PlanData = Pick<Snapshot, 'taskPlans' | 'tasks'> & Partial<Pick<Snapshot, 'chief'>>;
const activeStepStatuses = new Set([
  'queued',
  'running',
  'recovering',
  'waiting_children',
  'waiting_approval',
  'waiting_input',
]);
const statusLabels: Record<PlanStep['status'], string> = {
  pending: '待开始',
  skipped: '已跳过',
  queued: '排队中',
  running: '执行中',
  recovering: '正在恢复连接',
  waiting_children: '等待成员',
  waiting_approval: '等待批准',
  waiting_input: '等待回答',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
};

export function conversationTaskPlans(data: PlanData, conversation: Conversation): TaskPlan[] {
  return (data.taskPlans ?? [])
    .filter(
      (plan) =>
        plan.conversationId === conversation.id ||
        (conversation.purpose === 'task' && plan.taskId === conversation.sourceTaskId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function currentTaskPlan(data: PlanData, conversation: Conversation): TaskPlan | undefined {
  const conversationIds = isChiefHome(data, conversation)
    ? chiefConversationIds(data, conversation)
    : undefined;
  const plans = conversationIds
    ? data.taskPlans
        .filter((plan) => conversationIds.has(plan.conversationId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    : conversationTaskPlans(data, conversation);
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  return (
    plans.find((plan) => {
      const owner = tasks.get(plan.taskId);
      return owner
        ? recordTaskActive(owner)
        : plan.steps.some((step) => activeStepStatuses.has(step.status));
    }) ?? plans[0]
  );
}

export function planProgress(plan: TaskPlan): string {
  const completed = plan.steps.filter((step) => step.status === 'completed').length;
  const skipped = plan.steps.filter((step) => step.status === 'skipped').length;
  return `${completed}/${plan.steps.length} 步完成${skipped ? ` · ${skipped} 步跳过` : ''}`;
}

export function planCurrentSteps(plan: TaskPlan): string {
  const active = plan.steps.filter((step) => activeStepStatuses.has(step.status));
  const steps = active.length
    ? active
    : plan.steps.filter((step) => ['failed', 'interrupted', 'cancelled'].includes(step.status));
  if (!steps.length)
    return plan.steps.find((step) => step.status === 'pending')?.title ?? '安排已结束';
  return steps.map((step) => step.title).join(' · ');
}

export function planStepStatus(
  step: PlanStep,
  data: Pick<Snapshot, 'tasks' | 'processes'>,
): string {
  if (step.status !== 'queued') return statusLabels[step.status];
  const tasks = data.tasks.filter(
    (task) => step.taskIds.includes(task.id) && task.status === 'queued',
  );
  const labels = [...new Set(tasks.map((task) => taskRecordStatus(task, data.processes ?? [])))];
  return labels.length ? labels.join(' · ') : statusLabels.queued;
}

export function planDependencies(plan: TaskPlan, step: PlanStep): string {
  return step.dependencyIds
    .map((id) => {
      const index = plan.steps.findIndex((item) => item.id === id);
      return index < 0 ? id : `第 ${index + 1} 步`;
    })
    .join('、');
}
