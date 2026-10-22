import type { Task, TaskStatus } from './types.js';

export const terminal = (status: TaskStatus) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export const acceptsTaskInput = (task: Pick<Task, 'kind' | 'status'>, queuedInput = false) =>
  !task.kind && !terminal(task.status) && (task.status !== 'queued' || queuedInput);

export function childTaskRetryBlocker(children: readonly Task[]) {
  const unresolved = children.filter((child) => child.reconciliationRequired);
  if (unresolved.length) return { reason: 'reconciliation' as const, tasks: unresolved };
  const active = children.filter((child) => !terminal(child.status));
  if (active.length) return { reason: 'active' as const, tasks: active };
  return undefined;
}
