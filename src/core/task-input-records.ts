import type { Task, TaskInput } from '../domain/types.js';
import type { Storage } from './storage.js';
import { acceptsTaskInput } from '../domain/task-status.js';

export function taskInputs(storage: Storage): TaskInput[] {
  return storage.all<TaskInput>('deliveries').filter(item => item.kind === 'user-input');
}
export function receivingTask(storage: Storage, conversationId: string, botId: string): Task | undefined {
  const pending = new Set(taskInputs(storage).filter(input => input.status !== 'delivered').map(input => input.taskId));
  const priority = (task: Task) => ['running', 'recovering', 'waiting_approval'].includes(task.status) ? 0 : task.status === 'queued' ? 2 : 1;
  return storage.all<Task>('tasks').filter(task => task.conversationId === conversationId && task.botId === botId
    && acceptsTaskInput(task, pending.has(task.id))).sort((a, b) => priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt))[0];
}
export function recoverTaskInputs(storage: Storage) {
  for (const input of taskInputs(storage).filter(item => item.status === 'claimed'))
    storage.put('deliveries', { ...input, status: 'pending', runId: undefined });
}
