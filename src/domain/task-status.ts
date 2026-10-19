import type { Task, TaskStatus } from './types.js';

export const terminal = (status: TaskStatus) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export const acceptsTaskInput = (task: Pick<Task, 'kind' | 'status'>, queuedInput = false) =>
  !task.kind && !terminal(task.status) && (task.status !== 'queued' || queuedInput);
