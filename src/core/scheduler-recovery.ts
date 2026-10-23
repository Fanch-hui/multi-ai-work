import type { Run, Task, UserQuestion, SessionBinding } from '../domain/types.js';
import type { TaskWait } from '../domain/task-wait.js';
import { State, now } from './state.js';
import { recoverTaskInputs } from './task-input-records.js';
import { progressForRun, recoverManagedRuns } from './managed-progress.js';

export function recoverSchedulerState(state: State) {
  const s = state.storage;
  s.transaction(() => {
    const crashed = recoverRunningTasks(s);
    recoverToolOperations(s);
    interruptPendingWork(state);
    recoverTaskInputs(s);
    recoverManagedRuns(s, crashed);
  });
}

function recoverRunningTasks(s: State['storage']): string[] {
  const crashed: string[] = [];
  for (const run of s
    .all<Run>('runs')
    .filter((item) => ['running', 'waiting_approval'].includes(item.status))) {
    const question = s
      .all<UserQuestion>('questions')
      .find((item) => item.runId === run.id && item.status === 'pending');
    const wait = s
      .byField<TaskWait>('task_waits', 'runId', run.id)
      .find((item) => item.status !== 'cancelled');
    if (question || wait) {
      s.put('runs', { ...run, status: 'waiting_input', endedAt: now() });
      const task = s.get<Task>('tasks', run.taskId);
      if (task)
        s.put('tasks', {
          ...task,
          status: wait?.status === 'resumed' ? 'queued' : 'waiting_input',
          updatedAt: now(),
        });
      const binding = s.get<SessionBinding>('session_bindings', run.bindingId);
      if (binding?.nativeSessionId)
        s.put('session_bindings', {
          ...binding,
          generation: binding.generation + 1,
          nativeSessionId: undefined,
          lastDeliveredSequence: 0,
          memoryVersions: undefined,
        });
      continue;
    }
    crashed.push(run.id);
    s.put('runs', {
      ...run,
      status: 'interrupted',
      endedAt: now(),
      error: '上次运行未正常结束。',
    });
    const task = s.get<Task>('tasks', run.taskId);
    if (task)
      s.put('tasks', {
        ...task,
        status: 'interrupted',
        error: '上次运行未正常结束，请检查成果后重试。',
        updatedAt: now(),
      });
  }
  return crashed;
}

function recoverToolOperations(s: State['storage']) {
  for (const operation of s
    .all<{ id: string; status: string; runId: string }>('tool_operations')
    .filter((item) => item.status === 'dispatched')) {
    s.put('tool_operations', { ...operation, status: 'unknown' });
    const run = s.get<Run>('runs', operation.runId);
    const task = run && s.get<Task>('tasks', run.taskId);
    if (task) s.put('tasks', { ...task, reconciliationRequired: true });
  }
  for (const operation of s.all<{ id: string; status: string; runId: string }>('tool_operations')) {
    if (operation.status === 'prepared' && !progressForRun(s, operation.runId))
      s.put('tool_operations', { ...operation, status: 'failed' });
    if (operation.status !== 'unknown') continue;
    const run = s.get<Run>('runs', operation.runId);
    const task = run && s.get<Task>('tasks', run.taskId);
    if (task) s.put('tasks', { ...task, reconciliationRequired: true, status: 'interrupted' });
  }
}

function interruptPendingWork(state: State) {
  const s = state.storage;
  for (const approval of state.snapshot().approvals.filter((item) => item.status === 'pending'))
    s.put('approvals', { ...approval, status: 'rejected' });
  for (const message of s.messages().filter((item) => item.status === 'draft'))
    s.updateMessage({ ...message, status: 'interrupted' });
  for (const operation of s
    .all<{ id: string; status: string }>('compactions')
    .filter((item) => item.status === 'started'))
    s.put('compactions', { ...operation, status: 'failed', reason: 'interrupted' });
}
