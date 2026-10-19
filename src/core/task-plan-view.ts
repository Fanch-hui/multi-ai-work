import type { PlanStepStatus, TaskPlan, TaskPlanRecord } from '../domain/task-plan.js';
import type { Conversation, Task } from '../domain/types.js';
import type { Storage } from './storage.js';

export function taskPlanRoot(storage: Storage, task: Task): Task | undefined {
  let current = task;
  if (current.kind) return undefined;
  while (current.parentId) {
    const parent = storage.get<Task>('tasks', current.parentId);
    if (!parent) return undefined;
    if (parent.conversationId !== current.conversationId) {
      const room = storage.get<Conversation>('conversations', current.conversationId);
      if (
        room?.purpose !== 'task' ||
        room.sourceTaskId !== parent.id ||
        room.sourceConversationId !== parent.conversationId
      )
        return undefined;
    }
    current = parent;
  }
  return current;
}

export function taskPlanFor(storage: Storage, task: Task): TaskPlanRecord | undefined {
  const root = taskPlanRoot(storage, task);
  return root && storage.get<TaskPlanRecord>('task_plans', root.id);
}

function stepStatus(
  step: TaskPlanRecord['steps'][number],
  tasks: Task[],
  chiefId: string,
  root?: Task,
): PlanStepStatus {
  if (step.chiefStatus === 'skipped') return 'skipped';
  const states: PlanStepStatus[] = tasks.map((task) =>
    task.reconciliationRequired ? 'interrupted' : task.status,
  );
  const members = step.memberIds.filter((memberId) => memberId !== chiefId);
  if (members.some((memberId) => !tasks.some((task) => task.botId === memberId)))
    states.push('pending');
  if (step.kind === 'work' && step.memberIds.includes(chiefId))
    states.push(step.chiefStatus ?? 'pending');
  if (!states.length) states.push('pending');
  if (states.every((status) => status === 'completed')) return 'completed';
  if (!tasks.length && root && ['failed', 'cancelled', 'interrupted'].includes(root.status))
    return root.status;
  for (const status of [
    'failed',
    'interrupted',
    'running',
    'waiting_input',
    'waiting_approval',
    'waiting_children',
    'queued',
    'cancelled',
  ] as const)
    if (states.includes(status)) return status;
  if (root && ['failed', 'cancelled', 'interrupted'].includes(root.status)) return root.status;
  return states.includes('completed') ? 'running' : 'pending';
}

export function taskPlanView(plan: TaskPlanRecord, tasks: Task[], chiefId: string): TaskPlan {
  const root = tasks.find((task) => task.id === plan.taskId);
  return {
    ...plan,
    steps: plan.steps.map(({ chiefStatus: _status, ...step }) => {
      const linked = tasks.filter((task) => task.planId === plan.id && task.planStepId === step.id);
      return {
        ...step,
        status: stepStatus({ ...step, chiefStatus: _status }, linked, chiefId, root),
        taskIds: linked.map((task) => task.id),
        conversationIds: [...new Set(linked.map((task) => task.conversationId))],
      };
    }),
  };
}
