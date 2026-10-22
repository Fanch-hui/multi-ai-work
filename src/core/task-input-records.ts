import type { Task, TaskInput } from '../domain/types.js';
import type { Storage } from './storage.js';
import { acceptsTaskInput } from '../domain/task-status.js';

export function taskInputs(storage: Storage, taskId?: string): TaskInput[] {
  const inputs =
    taskId === undefined
      ? storage.all<TaskInput>('deliveries')
      : storage.byField<TaskInput>('deliveries', 'taskId', taskId);
  return inputs.filter((item) => item.kind === 'user-input');
}
export function receivingTasks(storage: Storage, conversationId: string): Map<string, Task> {
  const candidates = storage
    .byField<Task>('tasks', 'conversationId', conversationId)
    .filter((task) => acceptsTaskInput(task, true));
  const queued = candidates.filter((task) => task.status === 'queued').map((task) => task.id);
  const pendingRows = queued.length
    ? (storage
        .prepare(`SELECT DISTINCT json_extract(payload, '$.taskId') AS taskId FROM deliveries
        WHERE json_extract(payload, '$.taskId') IN (SELECT value FROM json_each(?))
          AND json_extract(payload, '$.kind') = 'user-input'
          AND json_extract(payload, '$.status') != 'delivered'`)
        .all(JSON.stringify(queued)) as { taskId: string }[])
    : [];
  const pending = new Set(pendingRows.map((row) => row.taskId));
  const priority = (task: Task) => {
    if (['running', 'recovering', 'waiting_approval'].includes(task.status)) return 0;
    return task.status === 'queued' ? 2 : 1;
  };
  const selected = new Map<string, Task>();
  for (const task of candidates
    .filter((task) => acceptsTaskInput(task, pending.has(task.id)))
    .sort((a, b) => priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt))) {
    if (!selected.has(task.botId)) selected.set(task.botId, task);
  }
  return selected;
}
export function recoverTaskInputs(storage: Storage) {
  for (const input of taskInputs(storage).filter((item) => item.status === 'claimed'))
    storage.put('deliveries', { ...input, status: 'pending', runId: undefined });
}
