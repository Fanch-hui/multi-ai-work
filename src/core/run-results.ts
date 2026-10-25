import type { Run, Task, SessionBinding, Usage } from '../domain/types.js';
import type { ProviderResult, RunContext } from '../domain/provider.js';
import { ModelRecoveryPendingError } from '../domain/recovery.js';
import type { State } from './state.js';
import { now } from './state.js';
import { TaskService, terminal } from './tasks.js';
import type { ToolRuntime } from './tool-runtime.js';
import type { TaskInputService } from './task-inputs.js';
import type { RunReplyWriter } from './run-reply.js';
import { runMessageSources } from './run-message.js';
import { addUsage } from './managed-context.js';
import { clearProgressDeltas } from './managed-progress-deltas.js';
import type { ManagedCheckpoint } from './managed-progress.js';
import { ManagedHistory } from './managed-history.js';
import { publicError } from './errors.js';
import type { RunPreparation } from './run-preparation.js';

type PreparedRun = Awaited<ReturnType<RunPreparation['prepare']>>;
export interface RunResultScope {
  run: Run;
  task: Task;
  binding: SessionBinding;
  writer: RunReplyWriter;
  cutoff: number;
}

function completionStatus(
  unknown: boolean,
  pendingInput: boolean,
  waiting: boolean,
): Task['status'] {
  if (unknown) return 'interrupted';
  if (pendingInput) return 'queued';
  if (waiting) return 'waiting_children';
  return 'completed';
}

export class RunResults {
  private history: ManagedHistory;
  constructor(
    private state: State,
    private tasks: TaskService,
    private tools: ToolRuntime,
    private inputs: TaskInputService,
  ) {
    this.history = new ManagedHistory(state);
  }

  completeCompaction(
    scope: RunResultScope,
    compaction: NonNullable<PreparedRun['compaction']>,
    usage?: Usage,
  ) {
    const { run, task, writer } = scope;
    writer.close();
    const s = this.state.storage;
    s.transaction(() => {
      s.put('runs', { ...s.get<Run>('runs', run.id)!, status: 'completed', endedAt: now(), usage });
      this.tasks.update(task, {
        status: 'completed',
        result: compaction.result,
        contextCompactionOutcome: compaction.outcome,
      });
    });
  }

  complete(
    scope: RunResultScope,
    prepared: PreparedRun,
    result: ProviderResult,
    inferenceDurationMs: number,
    summary?: Usage,
  ) {
    const { run, task, binding, writer, cutoff } = scope;
    const s = this.state.storage;
    const input = prepared.input;
    const draft = writer.current;
    const background = !!task.kind;
    const sources = runMessageSources(s, run.id);
    const resultText = result.text.trim()
      ? result.text
      : s
          .messages(task.conversationId)
          .filter(
            (message) =>
              message.runId &&
              sources.has(message.runId) &&
              message.authorBotId === run.botId &&
              message.status === 'committed',
          )
          .map((message) => message.content)
          .join('\n\n');
    if (!resultText.trim()) throw new Error('运行结束但未返回有效答复');
    if (task.kind === 'question-decision') {
      this.completeDecision(run, task, result, inferenceDurationMs, summary);
      return;
    }
    s.transaction(() => {
      const current = s.get<Task>('tasks', task.id)!;
      const children = s.byField<Task>('tasks', 'parentId', task.id);
      const reported =
        s.metadata<{ taskId: string; updatedAt?: string }[]>(`results:${task.id}`) ?? [];
      const waiting = children.some(
        (child) =>
          !terminal(child.status) ||
          !reported.some(
            (result) => result.taskId === child.id && result.updatedAt === child.updatedAt,
          ),
      );
      const unknown =
        children.some((child) => child.reconciliationRequired) ||
        current.runIds.some((source) =>
          s
            .byField<{ status: string }>('tool_operations', 'runId', source)
            .some((operation) => operation.status === 'unknown'),
        );
      s.put('runs', {
        ...(s.get<Run>('runs', run.id) ?? run),
        status: 'completed',
        endedAt: now(),
        usage: addUsage(result.usage, summary),
        inferenceDurationMs,
        inferenceUsage: result.usage,
        modelDurationMs: result.modelDurationMs ?? s.get<Run>('runs', run.id)?.modelDurationMs,
      });
      const published = background
        ? draft
        : writer.complete(writer.finalText(result.text), current.artifactIds);
      const lastDeliveredSequence = background ? 0 : this.inputs.complete(run.id, cutoff);
      const pendingInput = !background && this.inputs.hasPending(task.id);
      this.tasks.update(current, {
        status: completionStatus(unknown, pendingInput, waiting),
        reconciliationRequired: unknown,
        result: resultText,
        error: unknown ? '存在结果未知的操作，请核查后确认。' : undefined,
      });
      s.put('session_bindings', {
        ...(s.get<SessionBinding>('session_bindings', binding.id) ?? binding),
        nativeSessionId:
          result.nativeSessionId ??
          s.get<SessionBinding>('session_bindings', binding.id)?.nativeSessionId,
        lastDeliveredSequence,
        memoryVersions: prepared.memoryVersions,
      });
      if (!background) {
        if (result.messages)
          this.history.commit({
            input,
            messages: result.messages,
            draft: published,
            cutoff,
            output: result.text,
            projected: result.contextMessages,
          });
        else {
          s.put('provider_archive', {
            id: run.id,
            bindingId: binding.id,
            entries: [],
            output: result.text,
          });
          clearProgressDeltas(s, run.id);
        }
      }
    });
  }
  completeDecision(
    run: Run,
    task: Task,
    result: ProviderResult,
    duration: number,
    summary?: Usage,
  ) {
    const s = this.state.storage;
    s.transaction(() => {
      const answered = this.tools.questions.answerFromChief(task, result.text);
      s.put('runs', {
        ...(s.get<Run>('runs', run.id) ?? run),
        status: answered ? 'completed' : 'cancelled',
        endedAt: now(),
        usage: addUsage(result.usage, summary),
        inferenceUsage: result.usage,
        inferenceDurationMs: duration,
        modelDurationMs: result.modelDurationMs ?? s.get<Run>('runs', run.id)?.modelDurationMs,
      });
      this.tasks.update(task, {
        status: answered ? 'completed' : 'cancelled',
        result: result.text,
        error: answered ? undefined : '问题已处理或主管代答已停止',
      });
      s.put('provider_archive', {
        id: run.id,
        bindingId: run.bindingId,
        entries: [],
        messages: result.messages,
        output: result.text,
      });
      clearProgressDeltas(s, run.id);
    });
  }

  fail(
    scope: RunResultScope,
    error: unknown,
    signal: AbortSignal,
    usage?: Usage,
    duration?: number,
  ) {
    const { run, task, writer } = scope;
    const s = this.state.storage,
      status = signal.aborted ? 'cancelled' : 'failed';
    s.transaction(() => {
      s.put('runs', {
        ...(s.get<Run>('runs', run.id) ?? run),
        status,
        error: publicError(error),
        endedAt: now(),
        usage: duration === undefined ? usage : addUsage(usage, { source: 'unknown' }),
        inferenceDurationMs: duration,
      });
      const current = s.get<Task>('tasks', task.id)!;
      const children = s.byField<Task>('tasks', 'parentId', task.id);
      const unknown = current.runIds.some((source) =>
        s
          .byField<{ status: string }>('tool_operations', 'runId', source)
          .some((operation) => operation.status === 'unknown'),
      );
      this.tasks.update(current, {
        status:
          !signal.aborted && children.some((child) => !terminal(child.status))
            ? 'waiting_children'
            : status,
        error: publicError(error),
        reconciliationRequired: unknown,
      });
      if (!task.kind) writer.interrupt();
    });
  }

  waitForInput(
    scope: RunResultScope,
    input: RunContext | undefined,
    result: ProviderResult,
    duration?: number,
    summary?: Usage,
  ) {
    const { run, task, binding, writer, cutoff } = scope;
    const draft = writer.current;
    const s = this.state.storage,
      question = this.tools.questions.forRun(run.id),
      wait = this.tools.waits.forRun(run.id);
    if (!question && !wait) throw new Error('等待状态缺少记录');
    s.transaction(() => {
      s.put('runs', {
        ...(s.get<Run>('runs', run.id) ?? run),
        status: 'waiting_input',
        endedAt: now(),
        usage: addUsage(result.usage, summary),
        inferenceUsage: result.usage,
        inferenceDurationMs: duration,
        modelDurationMs: result.modelDurationMs ?? s.get<Run>('runs', run.id)?.modelDurationMs,
      });
      if (result.text.trim()) writer.complete(result.text, []);
      else writer.interrupt();
      this.tasks.update(task, {
        status:
          question?.status === 'answered' || wait?.status === 'resumed'
            ? 'queued'
            : 'waiting_input',
        error: undefined,
      });
      if (result.messages && input)
        this.history.commit({
          input,
          messages: result.messages,
          draft,
          cutoff,
          output: result.text,
          projected: result.contextMessages,
        });
      else {
        s.put('provider_archive', {
          id: run.id,
          bindingId: binding.id,
          entries: [],
          output: result.text,
          toolOperations: s.byField('tool_operations', 'runId', run.id),
        });
        clearProgressDeltas(s, run.id);
      }
      const current = s.get<SessionBinding>('session_bindings', binding.id) ?? binding;
      const renew = !result.messages;
      const delivered = renew ? 0 : this.inputs.complete(run.id, cutoff);
      if (renew)
        s.db
          .prepare('DELETE FROM metadata WHERE key IN (?, ?)')
          .run(`history:${binding.id}`, `history-validity:${binding.id}`);
      s.put('session_bindings', {
        ...current,
        lastDeliveredSequence: delivered,
        ...(renew
          ? {
              generation: current.generation + 1,
              nativeSessionId: undefined,
              memoryVersions: undefined,
            }
          : {}),
      });
    });
  }

  recover(
    scope: RunResultScope,
    error: unknown,
    signal: AbortSignal,
    hadActiveProcess: boolean,
    duration?: number,
    usage?: Usage,
  ): boolean {
    const { run, task } = scope;
    const s = this.state.storage;
    if (!(error instanceof ModelRecoveryPendingError) || signal.aborted || hadActiveProcess)
      return false;
    if (!s.get<{ checkpoint?: ManagedCheckpoint }>('provider_archive', run.id)?.checkpoint)
      return false;
    const unsettled = [...task.runIds, run.id].some((source) =>
      s
        .byField<{ status: string }>('tool_operations', 'runId', source)
        .some((operation) => ['unknown', 'dispatched'].includes(operation.status)),
    );
    if (unsettled) return false;
    s.transaction(() => {
      s.put('runs', {
        ...s.get<Run>('runs', run.id)!,
        status: 'interrupted',
        endedAt: now(),
        error: error.message,
        inferenceDurationMs: duration,
        usage: addUsage(usage, { source: 'unknown' }),
      });
      this.tasks.update(task, {
        status: 'recovering',
        recovery: error.recovery,
        resumeFromRunId: run.id,
        error: undefined,
      });
    });
    return true;
  }
}
