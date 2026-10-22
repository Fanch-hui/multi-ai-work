import type { Snapshot, Task } from '../../../src/domain/types.js';
import { isDeliverableArtifact } from '../../../src/domain/artifact-purpose.js';
import { currentActivityLabel } from './task-activity.js';
import {
  recordTaskActive,
  taskRecordActions,
  taskRecordStatus,
  toolActionTitle,
} from './conversation-records.js';
import { planCurrentSteps } from './task-plans.js';

const waitingPhases = new Set([
  'queued',
  'recovering',
  'children',
  'approval',
  'input',
  'stopping',
]);
const workingSteps = new Set([
  'queued',
  'running',
  'recovering',
  'waiting_children',
  'waiting_approval',
  'waiting_input',
]);

export function taskWorkOverview(data: Snapshot, task: Task) {
  const processes = (data.processes ?? []).filter((item) => item.taskId === task.id);
  const plan =
    (data.taskPlans ?? []).find((item) => item.taskId === task.id) ??
    (data.taskPlans ?? []).find((item) =>
      item.steps.some((step) => step.taskIds.includes(task.id)),
    );
  const steps =
    plan?.steps.filter((step) => plan.taskId === task.id || step.taskIds.includes(task.id)) ?? [];
  const currentSteps = steps.filter((step) => workingSteps.has(step.status));
  const notes = currentSteps
    .map((step) => step.note?.trim())
    .filter((note): note is string => !!note);
  const operations =
    task.activity?.operations?.map((item) => toolActionTitle(item.name, item.summary)) ??
    (recordTaskActive(task)
      ? taskRecordActions(data, task)
          .filter((item) => item.status === '执行中')
          .slice(0, 4)
          .map((item) => item.title)
      : []);
  const run = data.runs.find((item) => item.id === task.runIds.at(-1));
  let currentStep: string | undefined;
  if (plan)
    currentStep = currentSteps.length
      ? currentSteps.map((step) => step.title).join(' · ')
      : planCurrentSteps({ ...plan, steps });
  return {
    stage: currentActivityLabel(task, run) ?? taskRecordStatus(task, processes),
    currentStep,
    progress: plan
      ? `${steps.filter((step) => step.status === 'completed').length}/${steps.length} 步`
      : undefined,
    note: notes.join(' · ') || undefined,
    operations,
    operationCount: task.activity?.operationCount ?? operations.length,
    waiting: taskWaiting(data, task),
    deliverables: data.artifacts.filter(
      (item) => task.artifactIds.includes(item.id) && isDeliverableArtifact(item),
    ).length,
    processes,
  };
}

function taskWaiting(data: Snapshot, task: Task): string[] {
  const waiting = new Set<string>();
  const children =
    task.status === 'waiting_children'
      ? data.tasks.filter((item) => item.parentId === task.id && recordTaskActive(item))
      : [];
  const names = [
    ...new Set(
      children.map((item) => data.bots.find((bot) => bot.id === item.botId)?.name ?? '成员'),
    ),
  ];
  const approval = data.approvals.some(
    (item) => item.taskId === task.id && item.status === 'pending',
  );
  const question = (data.questions ?? []).some(
    (item) => item.taskId === task.id && item.status === 'pending',
  );
  const phase = task.activity?.phase;
  const hasSpecificWait =
    (phase === 'children' && names.length > 0) ||
    (phase === 'approval' && approval) ||
    (phase === 'input' && question);
  if (task.activity?.waitingFor && waitingPhases.has(task.activity.phase) && !hasSpecificWait)
    waiting.add(task.activity.waitingFor);
  if (names.length) waiting.add(`等待${names.join('、')}返回结果`);
  if (approval) waiting.add('有操作等待你的批准');
  if (question) waiting.add('有问题等待你的回答');
  if (task.reconciliationRequired) waiting.add('操作结果待核查');
  return [...waiting];
}
