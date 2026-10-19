import type {
  Bot,
  Connection,
  Conversation,
  Run,
  Task,
  TaskQueueReason,
  UserQuestion,
} from '../domain/types.js';
import type { ProviderAdapter } from '../domain/provider.js';
import { State, id, now } from './state.js';
import { Executor } from './executor.js';
import { TaskService, terminal } from './tasks.js';
import { publicError } from './errors.js';
import { questionChief } from './question-policy.js';
import { recoverSchedulerState } from './scheduler-recovery.js';

function priority(task: Task): number {
  if (task.kind === 'memory-review') return 2;
  if (task.kind === 'question-decision') return 1;
  return 0;
}

interface Candidate {
  task: Task;
  dependencies: (Task | undefined)[];
  account: string;
  bindingKey: string;
}

interface Active {
  task: Task;
  controller: AbortController;
  account: string;
  bindingKey: string;
  completion: Promise<void>;
}
export class Scheduler {
  private active = new Map<string, Active>();
  private scheduled = false;
  private stopped = false;
  private paused = false;
  private unsubscribe?: () => void;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private state: State,
    private tasks: TaskService,
    private executor: Executor,
    private adapters: ProviderAdapter[],
  ) {
    this.state.queueReasonFor = (task) => this.queueReason(task);
  }

  private queueReason(task: Task): TaskQueueReason | undefined {
    if (!['queued', 'recovering'].includes(task.status)) return undefined;
    return this.candidateQueueReason(this.candidate(task));
  }

  private candidate(task: Task, bot?: Bot): Candidate {
    const s = this.state.storage;
    const dependencies = task.dependencyIds.map((taskId) => s.get<Task>('tasks', taskId));
    const member = bot ?? s.get<Bot>('bots', task.botId);
    const connection = member && s.get<Connection>('connections', member.connectionId);
    return {
      task,
      dependencies,
      account: connection?.accountScope ?? connection?.id ?? task.botId,
      bindingKey: `${task.botId}:${task.conversationId}`,
    };
  }

  private candidateQueueReason(candidate: Candidate): TaskQueueReason | undefined {
    const { task, dependencies, account, bindingKey } = candidate;
    const s = this.state.storage;
    if (dependencies.some((dependency) => dependency?.status !== 'completed'))
      return 'dependencies';
    const active = [...this.active.values()];
    if (active.some((item) => item.bindingKey === bindingKey)) return 'session_busy';
    if (
      s
        .byField<Task>('tasks', 'status', 'recovering')
        .some(
          (item) =>
            item.id !== task.id &&
            item.botId === task.botId &&
            item.conversationId === task.conversationId,
        )
    )
      return 'session_busy';
    if (active.filter((item) => item.account === account).length >= this.accountLimit(account))
      return 'account_limit';
    if (active.length >= this.state.settings().maxActiveRuns) return 'global_limit';
    return undefined;
  }

  private accountLimit(account: string): number {
    const limits = this.state.storage
      .all<Connection>('connections')
      .filter((item) => (item.accountScope ?? item.id) === account)
      .map((item) => item.concurrency);
    return limits.length ? Math.min(...limits) : 1;
  }

  start() {
    recoverSchedulerState(this.state);
    this.unsubscribe = this.state.subscribe((kind) => {
      if (kind === 'state') this.kick();
    });
    this.kick();
  }
  kick() {
    if (this.scheduled || this.stopped || this.paused) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.pump();
    }, 10);
  }
  private pump() {
    if (this.stopped || this.paused) return;
    this.tasks.settleParents();
    for (const task of this.pendingTasks()) {
      if (this.active.size >= this.state.settings().maxActiveRuns) break;
      if (this.active.has(task.id)) continue;
      if (!this.tasks.accepting(task.conversationId)) continue;
      const candidate = this.admittedCandidate(task);
      if (candidate) this.launch(candidate);
    }
  }

  private pendingTasks(): Task[] {
    const s = this.state.storage;
    const recovering = s.byField<Task>('tasks', 'status', 'recovering');
    clearTimeout(this.recoveryTimer);
    const future = recovering
      .map((task) => Date.parse(task.recovery?.nextAttemptAt ?? ''))
      .filter((time) => time > Date.now());
    if (future.length)
      this.recoveryTimer = setTimeout(
        () => this.kick(),
        Math.max(10, Math.min(...future) - Date.now()),
      );
    const due = recovering.filter(
      (task) => task.recovery && Date.parse(task.recovery.nextAttemptAt) <= Date.now(),
    );
    return [...due, ...s.byField<Task>('tasks', 'status', 'queued')].sort(
      (a, b) => priority(a) - priority(b),
    );
  }

  private admittedCandidate(task: Task): Candidate | undefined {
    const s = this.state.storage;
    if (task.kind === 'question-decision') {
      const question = task.questionId
        ? s.get<UserQuestion>('questions', task.questionId)
        : undefined;
      if (
        !question ||
        question.status !== 'pending' ||
        question.chiefTaskId !== task.id ||
        !this.state.settings().autoAnswerMemberQuestions ||
        questionChief(this.state, question)?.id !== task.botId
      ) {
        this.tasks.update(task, { status: 'cancelled', error: '问题已处理或主管代答已停止' });
        return undefined;
      }
    }
    const room = s.get<Conversation>('conversations', task.conversationId);
    const bot = s.get<Bot>('bots', task.botId);
    if (!bot || bot.archived || !room?.memberIds.includes(task.botId)) {
      this.tasks.update(task, { status: 'cancelled', error: '智能体已离开此对话。' });
      return undefined;
    }
    const candidate = this.candidate(task, bot);
    const { dependencies } = candidate;
    if (
      dependencies.some(
        (dependency) =>
          dependency && terminal(dependency.status) && dependency.status !== 'completed',
      )
    ) {
      this.tasks.update(task, {
        status: 'failed',
        error: '前置任务未完成，已保留独立任务成果。',
      });
      return undefined;
    }
    if (dependencies.some((dependency) => !dependency || dependency.status !== 'completed'))
      return undefined;
    if (this.candidateQueueReason(candidate)) return undefined;
    return candidate;
  }

  private launch(candidate: Candidate) {
    const { task, account, bindingKey } = candidate;
    const controller = new AbortController();
    const completion = this.executor
      .execute(task, controller.signal)
      .catch((error) => {
        if (task.kind === 'question-decision' && !controller.signal.aborted)
          this.executor.questionDecisionFailed(task, publicError(error));
        this.tasks.update(task, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: publicError(error),
        });
      })
      .finally(() => {
        this.active.delete(task.id);
        this.state.changed();
        this.kick();
      });
    this.active.set(task.id, { task, controller, account, bindingKey, completion });
  }

  async cancel(taskId: string) {
    const s = this.state.storage;
    const task = s.get<Task>('tasks', taskId);
    if (!task || terminal(task.status)) return;
    this.executor.cancelQuestions(task);
    const active = this.active.get(taskId);
    if (active) {
      const run = task.runIds.at(-1) ? s.get<Run>('runs', task.runIds.at(-1)!) : undefined;
      if (run && !run.cancelRequestedAt) {
        s.put('runs', { ...run, cancelRequestedAt: now() });
        s.event({
          id: id(),
          runId: run.id,
          type: 'status',
          data: { phase: 'cancel-requested' },
          createdAt: now(),
        });
        this.state.changed();
      }
      active.controller.abort();
    } else
      this.tasks.update(task, {
        status: 'cancelled',
        recovery: undefined,
        resumeFromRunId: undefined,
      });
    const decisions = new Set(
      s
        .all<UserQuestion>('questions')
        .filter((item) => item.taskId === task.id)
        .map((item) => item.chiefTaskId),
    );
    const children = s
      .all<Task>('tasks')
      .filter((item) => item.parentId === taskId || decisions.has(item.id));
    await Promise.all(children.map((child) => this.cancel(child.id)));
    if (active) await active.completion;
  }
  async cancelConnection(connectionId: string) {
    const botIds = new Set(
      this.state.storage
        .all<Bot>('bots')
        .filter((bot) => bot.connectionId === connectionId)
        .map((bot) => bot.id),
    );
    for (const task of this.state.storage
      .all<Task>('tasks')
      .filter((task) => botIds.has(task.botId) && !terminal(task.status)))
      await this.cancel(task.id);
  }
  hasActive() {
    return this.active.size > 0;
  }
  pause() {
    this.paused = true;
  }
  resume(recover = false) {
    if (recover) recoverSchedulerState(this.state);
    this.paused = false;
    this.kick();
  }
  async close() {
    this.stopped = true;
    this.unsubscribe?.();
    clearTimeout(this.recoveryTimer);
    const active = [...this.active.values()];
    for (const task of this.state.storage.byField<Task>('tasks', 'status', 'recovering'))
      this.tasks.update(task, {
        status: 'cancelled',
        recovery: undefined,
        resumeFromRunId: undefined,
      });
    for (const item of active) {
      const task = this.state.storage.get<Task>('tasks', item.task.id);
      const run = task?.runIds.at(-1)
        ? this.state.storage.get<Run>('runs', task.runIds.at(-1)!)
        : undefined;
      if (run)
        this.state.storage.put('runs', {
          ...run,
          cancelRequestedAt: run.cancelRequestedAt ?? now(),
        });
      item.controller.abort();
    }
    await Promise.allSettled(active.map((item) => item.completion));
    for (const adapter of this.adapters) await adapter.close?.();
  }
}
