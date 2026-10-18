import type { ManagedProgress, ManagedProgressChange, RunContext } from '../domain/provider.js';
import type { Message, Run, SessionBinding, Task, TaskInput } from '../domain/types.js';
import type { ModelRecovery } from '../domain/recovery.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { ProviderArchive } from './managed-context.js';
import type { Storage } from './storage.js';
import { now } from './state.js';
import { clearProgressDeltas, replayProgressDeltas, saveProgressDelta } from './managed-progress-deltas.js';

export interface ManagedCheckpoint {
  taskId: string;
  conversationId: string;
  botId: string;
  generation: number;
  workspaceId: string;
  draftId: string;
  cutoff: number;
  progress: ManagedProgress;
}
interface ProgressArchive extends ProviderArchive { checkpoint?: ManagedCheckpoint; }

export function progressForRun(storage: Storage, runId: string): ManagedCheckpoint | undefined {
  const saved = storage.get<ProgressArchive>('provider_archive', runId)?.checkpoint;
  if (saved) replayProgressDeltas(storage, runId, saved.progress);
  return saved;
}

export function latestProgressRun(storage: Storage, task: Task): string | undefined {
  let run = task.runIds.at(-1) ? storage.get<Run>('runs', task.runIds.at(-1)!) : undefined;
  while (run && !['completed', 'waiting_input'].includes(run.status)) {
    if (progressForRun(storage, run.id)?.taskId === task.id) return run.id;
    run = run.resumeFromRunId ? storage.get<Run>('runs', run.resumeFromRunId) : undefined;
  }
  return undefined;
}

export function loadManagedProgress(storage: Storage, task: Task, binding: SessionBinding): ManagedCheckpoint | undefined {
  if (!task.resumeFromRunId) return undefined;
  const archive = storage.get<ProgressArchive>('provider_archive', task.resumeFromRunId);
  const saved = progressForRun(storage, task.resumeFromRunId);
  if (!saved || saved.taskId !== task.id || saved.botId !== task.botId || saved.conversationId !== task.conversationId)
    throw new Error('任务恢复进度不存在，请核查已有成果');
  if (archive?.bindingId !== binding.id || saved.generation !== binding.generation || saved.workspaceId !== binding.workspaceId)
    throw new Error('模型、连接或工作目录已变化，无法直接续接原运行');
  const progress = structuredClone(saved.progress);
  if (!task.recovery && progress.earlyFailures) progress.earlyFailures = 0;
  if (!task.recovery && ['ready', 'request'].includes(progress.phase)) {
    progress.phase = 'ready'; progress.attempt = 0; progress.recovery = undefined;
  }
  return { ...saved, progress };
}

export function saveManagedProgress(storage: Storage, run: Run, task: Task, binding: SessionBinding,
  draft: Message, cutoff: number, input: RunContext, progress: ManagedProgress, change?: ManagedProgressChange) {
  storage.transaction(() => {
    if (!change || !saveProgressDelta(storage, run.id, progress, change)) {
      storage.put('provider_archive', { id: run.id, bindingId: binding.id, entries: [], checkpoint: {
        taskId: task.id, conversationId: task.conversationId, botId: task.botId, generation: binding.generation,
        workspaceId: binding.workspaceId, draftId: draft.id, cutoff, progress,
      } satisfies ManagedCheckpoint });
      clearProgressDeltas(storage, run.id);
    }
    if (progress.phase === 'tools' || progress.phase === 'complete')
      input.userInput?.acknowledge?.(progress.pendingInputIds);
  });
}

export function restoreProgressInputs(storage: Storage, run: Run, saved: ManagedCheckpoint) {
  const included = new Set(progressMessages(saved.progress).flatMap(message => message.sourceMessageId ? [message.sourceMessageId] : []));
  for (const input of storage.all<TaskInput>('deliveries').filter(item => item.kind === 'user-input'
    && item.taskId === run.taskId && item.status !== 'delivered' && included.has(item.messageId)))
    storage.put('deliveries', { ...input, runId: run.id, status: 'claimed' });
}

export function restoreProgressTools(storage: Storage, task: Task, saved: ManagedCheckpoint,
  context: ToolExecutionContext): Record<string, string> {
  const calls = new Set(progressMessages(saved.progress).flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
  const operations: Record<string, string> = {};
  for (const runId of task.runIds) {
    for (const operation of storage.byField<{ id: string; runId: string }>('tool_operations', 'runId', runId)) {
      const callId = operation.id.slice(runId.length + 1);
      if (calls.has(callId)) operations[callId] = operation.id;
    }
  }
  for (const callId of calls) {
    const operation = operations[callId] && storage.get<{ name: string; status: string; result?: { path?: string; version?: string } }>('tool_operations', operations[callId]);
    if (operation && operation.status === 'succeeded' && ['read_file', 'write_file', 'edit_file'].includes(operation.name)
      && typeof operation.result?.path === 'string' && typeof operation.result.version === 'string')
      context.observeFile?.(operation.result.path, operation.result.version);
  }
  return operations;
}

export function recoverManagedRuns(storage: Storage, runIds: string[]) {
  for (const runId of runIds) {
    const run = storage.get<Run>('runs', runId), saved = progressForRun(storage, runId);
    const task = run && storage.get<Task>('tasks', run.taskId);
    if (!run || !task || !saved || task.kind || run.cancelRequestedAt || task.reconciliationRequired
      || task.status !== 'interrupted') continue;
    const processes = storage.byField<{ status: string }>('processes', 'runId', runId);
    if (processes.some(process => ['running', 'unknown'].includes(process.status))) continue;
    const progress = structuredClone(saved.progress);
    if (progress.phase === 'request') {
      if (progress.attempt >= 5) {
        storage.put('tasks', { ...task, status: 'failed', error: '模型连接恢复已达到 5 次，请检查网络后继续原任务' });
        continue;
      }
      progress.phase = 'ready'; progress.attempt++;
    }
    const recovery: ModelRecovery = progress.recovery ?? { attempt: progress.attempt, maxAttempts: 5,
      nextAttemptAt: now(), reason: '继续上次中断的运行' };
    progress.recovery = recovery;
    const archive = storage.get<ProgressArchive>('provider_archive', runId)!;
    storage.transaction(() => {
      storage.put('provider_archive', { ...archive, checkpoint: { ...saved, progress } });
      clearProgressDeltas(storage, runId);
      storage.put('tasks', { ...task, status: 'recovering', recovery, resumeFromRunId: runId, error: undefined, updatedAt: now() });
    });
  }
}

function progressMessages(progress: ManagedProgress) {
  return progress.compaction
    ? [...progress.compaction.archived, ...progress.messages.slice(progress.compaction.start)] : progress.messages;
}
