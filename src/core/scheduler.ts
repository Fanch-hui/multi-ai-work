import type { Bot, Connection, Conversation, Run, Task, TaskQueueReason, UserQuestion, SessionBinding } from '../domain/types.js';
import type { ProviderAdapter } from '../domain/provider.js';
import { State, id, now } from './state.js';
import { Executor } from './executor.js';
import { TaskService, terminal } from './tasks.js';
import { publicError } from './errors.js';
import { questionChief } from './question-policy.js';
import { recoverTaskInputs } from './task-input-records.js';
import { progressForRun, recoverManagedRuns } from './managed-progress.js';

const priority = (task: Task) => task.kind === 'memory-review' ? 2 : task.kind === 'question-decision' ? 1 : 0;

interface Active { task: Task; controller: AbortController; account: string; bindingKey: string; completion: Promise<void>; }
export class Scheduler {
  private active = new Map<string, Active>();
  private scheduled = false;
  private stopped = false;
  private paused = false;
  private unsubscribe?: () => void;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  constructor(private state: State, private tasks: TaskService, private executor: Executor,
    private adapters: ProviderAdapter[]) {
    this.state.queueReasonFor = task => this.queueReason(task);
  }

  private queueReason(task: Task): TaskQueueReason | undefined {
    if (!['queued', 'recovering'].includes(task.status)) return undefined;
    const s = this.state.storage;
    if (task.dependencyIds.some(id => s.get<Task>('tasks', id)?.status !== 'completed')) return 'dependencies';
    const active = [...this.active.values()];
    if (active.some(item => item.bindingKey === `${task.botId}:${task.conversationId}`)) return 'session_busy';
    if (s.byField<Task>('tasks', 'status', 'recovering').some(item => item.id !== task.id
      && item.botId === task.botId && item.conversationId === task.conversationId)) return 'session_busy';
    const bot = s.get<Bot>('bots', task.botId);
    const connection = bot && s.get<Connection>('connections', bot.connectionId);
    const account = connection?.accountScope ?? connection?.id ?? task.botId;
    if (active.filter(item => item.account === account).length >= this.accountLimit(account)) return 'account_limit';
    if (active.length >= this.state.settings().maxActiveRuns) return 'global_limit';
    return undefined;
  }

  private accountLimit(account: string): number {
    const limits = this.state.storage.all<Connection>('connections')
      .filter(item => (item.accountScope ?? item.id) === account).map(item => item.concurrency);
    return limits.length ? Math.min(...limits) : 1;
  }

  start() {
    this.recover();
    this.unsubscribe = this.state.subscribe(kind => { if (kind === 'state') this.kick(); });
    this.kick();
  }
  kick() {
    if (this.scheduled || this.stopped || this.paused) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.pump(); }, 10);
  }
  private pump() {
    if (this.stopped || this.paused) return;
    this.tasks.settleParents();
    const s = this.state.storage;
    const recovering = s.byField<Task>('tasks', 'status', 'recovering');
    clearTimeout(this.recoveryTimer);
    const future = recovering.map(task => Date.parse(task.recovery?.nextAttemptAt ?? '')).filter(time => time > Date.now());
    if (future.length) this.recoveryTimer = setTimeout(() => this.kick(), Math.max(10, Math.min(...future) - Date.now()));
    const due = recovering.filter(task => task.recovery && Date.parse(task.recovery.nextAttemptAt) <= Date.now());
    for (const task of [...due, ...s.byField<Task>('tasks', 'status', 'queued')]
      .sort((a, b) => priority(a) - priority(b))) {
      if (this.active.size >= this.state.settings().maxActiveRuns) break;
      if (this.active.has(task.id)) continue;
      if (!this.tasks.accepting(task.conversationId)) continue;
      if (task.kind === 'question-decision') {
        const question = task.questionId ? s.get<UserQuestion>('questions', task.questionId) : undefined;
        if (!question || question.status !== 'pending' || question.chiefTaskId !== task.id
          || !this.state.settings().autoAnswerMemberQuestions || questionChief(this.state, question)?.id !== task.botId) {
          this.tasks.update(task, { status: 'cancelled', error: '问题已处理或主管代答已停止' }); continue;
        }
      }
      const room = s.get<Conversation>('conversations', task.conversationId);
      const bot = s.get<Bot>('bots', task.botId);
      if (!bot || bot.archived || !room?.memberIds.includes(task.botId)) {
        this.tasks.update(task, { status: 'cancelled', error: '智能体已离开此对话。' }); continue;
      }
      const dependencies = task.dependencyIds.map(taskId => s.get<Task>('tasks', taskId));
      if (dependencies.some(dependency => dependency && terminal(dependency.status) && dependency.status !== 'completed')) {
        this.tasks.update(task, { status: 'failed', error: '前置任务未完成，已保留独立任务成果。' }); continue;
      }
      if (dependencies.some(dependency => !dependency || dependency.status !== 'completed')) continue;
      const connection = bot ? s.get<Connection>('connections', bot.connectionId) : undefined;
      const account = connection?.accountScope ?? connection?.id ?? task.botId;
      const bindingKey = `${task.botId}:${task.conversationId}`;
      if (this.queueReason(task)) continue;
      const controller = new AbortController();
      const completion = this.executor.execute(task, controller.signal).catch(error => {
        if (task.kind === 'question-decision' && !controller.signal.aborted) this.executor.questionDecisionFailed(task, publicError(error));
        this.tasks.update(task, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: publicError(error) });
      }).finally(() => { this.active.delete(task.id); this.state.changed(); this.kick(); });
      this.active.set(task.id, { task, controller, account, bindingKey, completion });
    }
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
        s.event({ id: id(), runId: run.id, type: 'status', data: { phase: 'cancel-requested' }, createdAt: now() });
        this.state.changed();
      }
      active.controller.abort();
    }
    else this.tasks.update(task, { status: 'cancelled', recovery: undefined, resumeFromRunId: undefined });
    const decisions = new Set(s.all<UserQuestion>('questions').filter(item => item.taskId === task.id).map(item => item.chiefTaskId));
    const children = s.all<Task>('tasks').filter(item => item.parentId === taskId || decisions.has(item.id));
    await Promise.all(children.map(child => this.cancel(child.id)));
    if (active) await active.completion;
  }
  async cancelConnection(connectionId: string) {
    const botIds = new Set(this.state.storage.all<Bot>('bots').filter(bot => bot.connectionId === connectionId).map(bot => bot.id));
    for (const task of this.state.storage.all<Task>('tasks').filter(task => botIds.has(task.botId) && !terminal(task.status))) await this.cancel(task.id);
  }
  hasActive() { return this.active.size > 0; }
  pause() { this.paused = true; }
  resume(recover = false) { if (recover) this.recover(); this.paused = false; this.kick(); }
  async close() {
    this.stopped = true; this.unsubscribe?.();
    clearTimeout(this.recoveryTimer);
    const active = [...this.active.values()];
    for (const task of this.state.storage.byField<Task>('tasks', 'status', 'recovering'))
      this.tasks.update(task, { status: 'cancelled', recovery: undefined, resumeFromRunId: undefined });
    for (const item of active) {
      const task = this.state.storage.get<Task>('tasks', item.task.id);
      const run = task?.runIds.at(-1) ? this.state.storage.get<Run>('runs', task.runIds.at(-1)!) : undefined;
      if (run) this.state.storage.put('runs', { ...run, cancelRequestedAt: run.cancelRequestedAt ?? now() });
      item.controller.abort();
    }
    await Promise.allSettled(active.map(item => item.completion));
    for (const adapter of this.adapters) await adapter.close?.();
  }
  private recover() {
    const s = this.state.storage;
    const crashed: string[] = [];
    s.transaction(() => {
      for (const run of s.all<Run>('runs').filter(item => ['running', 'waiting_approval'].includes(item.status))) {
        const question = s.all<UserQuestion>('questions').find(item => item.runId === run.id && item.status === 'pending');
        if (question) {
          s.put('runs', { ...run, status: 'waiting_input', endedAt: now() });
          const task = s.get<Task>('tasks', run.taskId);
          if (task) s.put('tasks', { ...task, status: 'waiting_input', updatedAt: now() });
          const binding = s.get<SessionBinding>('session_bindings', run.bindingId);
          if (binding?.nativeSessionId) s.put('session_bindings', { ...binding, generation: binding.generation + 1, nativeSessionId: undefined, lastDeliveredSequence: 0, memoryVersions: undefined });
          continue;
        }
        crashed.push(run.id);
        s.put('runs', { ...run, status: 'interrupted', endedAt: now(), error: '上次运行未正常结束。' });
        const task = s.get<Task>('tasks', run.taskId);
        if (task) s.put('tasks', { ...task, status: 'interrupted', error: '上次运行未正常结束，请检查成果后重试。', updatedAt: now() });
      }
      for (const operation of s.all<{ id: string; status: string; runId: string }>('tool_operations').filter(item => item.status === 'dispatched')) {
        s.put('tool_operations', { ...operation, status: 'unknown' });
        const run = s.get<Run>('runs', operation.runId);
        const task = run && s.get<Task>('tasks', run.taskId);
        if (task) s.put('tasks', { ...task, reconciliationRequired: true });
      }
      for (const operation of s.all<{ id: string; status: string; runId: string }>('tool_operations')) {
        if (operation.status === 'prepared' && !progressForRun(s, operation.runId)) s.put('tool_operations', { ...operation, status: 'failed' });
        if (operation.status !== 'unknown') continue;
        const run = s.get<Run>('runs', operation.runId);
        const task = run && s.get<Task>('tasks', run.taskId);
        if (task) s.put('tasks', { ...task, reconciliationRequired: true, status: 'interrupted' });
      }
      for (const approval of this.state.snapshot().approvals.filter(item => item.status === 'pending')) s.put('approvals', { ...approval, status: 'rejected' });
      for (const message of s.messages().filter(item => item.status === 'draft')) s.updateMessage({ ...message, status: 'interrupted' });
      for (const operation of s.all<{ id: string; status: string }>('compactions').filter(item => item.status === 'started'))
        s.put('compactions', { ...operation, status: 'failed', reason: 'interrupted' });
      recoverTaskInputs(s);
      recoverManagedRuns(s, crashed);
    });
  }
}
