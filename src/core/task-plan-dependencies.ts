import type { PlanStepInput, TaskPlanRecord } from '../domain/task-plan.js';
import type { Task } from '../domain/types.js';
import { required } from './errors.js';
import { taskPlanView } from './task-plan-view.js';

export function planStepDependencies(
  plan: TaskPlanRecord,
  step: PlanStepInput,
  tasks: Task[],
  chiefId: string,
  parentId: string,
  conversationId: string,
): string[] {
  const view = taskPlanView(plan, tasks, chiefId);
  const dependencies: string[] = [];
  for (const dependencyId of step.dependencyIds) {
    const previous = required(
      view.steps.find((item) => item.id === dependencyId),
      '前置步骤不存在',
    );
    if (previous.status === 'completed' || previous.status === 'skipped') continue;
    const linked = tasks.filter((task) => previous.taskIds.includes(task.id));
    if (
      (previous.memberIds.includes(chiefId) &&
        previous.kind === 'work' &&
        plan.steps.find((item) => item.id === previous.id)?.chiefStatus !== 'completed') ||
      previous.memberIds
        .filter((memberId) => memberId !== chiefId)
        .some((memberId) => !linked.some((task) => task.botId === memberId)) ||
      !linked.length ||
      linked.some((task) => task.parentId !== parentId || task.conversationId !== conversationId)
    )
      throw new Error('请先完成管家前置工作，并完整派发前置步骤的成员任务');
    dependencies.push(...linked.map((task) => task.id));
  }
  return dependencies;
}

export function samePlanDependencies(first: PlanStepInput, second: PlanStepInput) {
  return (
    JSON.stringify([...first.dependencyIds].sort()) ===
    JSON.stringify([...second.dependencyIds].sort())
  );
}

export function rescheduledPlanTasks(
  previous: TaskPlanRecord | undefined,
  plan: TaskPlanRecord,
  tasks: Task[],
  chiefId: string,
): Task[] {
  const updated: Task[] = [];
  for (const step of plan.steps) {
    const before = previous?.steps.find((item) => item.id === step.id);
    if (!before || samePlanDependencies(before, step)) continue;
    const assigned = tasks.filter((task) => task.planId === plan.id && task.planStepId === step.id);
    for (const task of assigned) {
      const planned = planStepDependencies(
        plan,
        step,
        tasks,
        chiefId,
        required(task.parentId, '安排委派缺少主管任务'),
        task.conversationId,
      );
      if (
        !task.explicitDependencyIds &&
        tasks.some(
          (dependency) =>
            dependency.planId === plan.id &&
            before.dependencyIds.includes(dependency.planStepId ?? '') &&
            task.dependencyIds.includes(dependency.id) &&
            !planned.includes(dependency.id),
        )
      )
        throw new Error('旧任务未记录前置依赖来源，请结束当前任务，在新任务中按新安排重新委派');
      updated.push({
        ...task,
        dependencyIds: [
          ...new Set([...(task.explicitDependencyIds ?? task.dependencyIds), ...planned]),
        ],
        updatedAt: new Date().toISOString(),
      });
    }
  }
  requireAcyclicTaskDependencies(tasks, updated);
  return updated;
}

function requireAcyclicTaskDependencies(tasks: Task[], updated: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of updated) byId.set(task.id, task);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) throw new Error('安排调整会造成任务循环依赖');
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of byId.get(taskId)?.dependencyIds ?? []) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of updated) visit(task.id);
}
