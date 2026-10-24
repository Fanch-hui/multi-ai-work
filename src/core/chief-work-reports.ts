import { createHash } from 'node:crypto';
import type { ChiefInput, ChiefWorkContext } from '../domain/chief-work.js';
import type { Artifact, Conversation, Task, UserQuestion } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import type { State } from './state.js';
import { id, now } from './state.js';
import type { TaskService } from './tasks.js';
import type { ChiefContextService } from './chief-contexts.js';
import { accessibleArtifacts } from './tool-access.js';
import type { Routine } from '../domain/routines.js';
import type { TaskPlanRecord } from '../domain/task-plan.js';
import { taskPlanView } from './task-plan-view.js';

interface WorkReport {
  id: string;
  workId: string;
  taskId: string;
  status?: Task['status'];
  runId?: string;
  content: string;
  artifactIds: string[];
  createdAt: string;
  messageId?: string;
  deliveredAt?: string;
  suspended?: boolean;
  supersededBy?: string;
}

export class ChiefWorkReports {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = true;
  constructor(
    private state: State,
    private tasks: TaskService,
    private contexts: ChiefContextService,
  ) {}
  start() {
    this.closed = false;
    this.unsubscribe = this.state.subscribe((kind) => {
      if (kind === 'state') this.schedule();
    });
    this.schedule();
  }
  close() {
    this.closed = true;
    this.unsubscribe?.();
    clearTimeout(this.timer);
  }
  private schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      this.collect();
      this.flush();
    }, 30);
    this.timer.unref?.();
  }
  private get key() {
    return `chief-work-reports:${this.contexts.homeId}`;
  }
  private collect() {
    const s = this.state.storage;
    const reports = s.metadata<WorkReport[]>(this.key) ?? [];
    const known = new Set(reports.map((report) => report.id));
    const restoredTasks = new Set(s.metadata<string[]>('chief-restored-report-tasks') ?? []);
    for (const work of s.byField<ChiefWorkContext>(
      'chief_contexts',
      'homeConversationId',
      this.contexts.homeId,
    )) {
      if (work.kind !== 'work') continue;
      const parts = s.byField<{ conversationId: string }>('chief_parts', 'contextId', work.id);
      for (const part of parts) {
        for (const task of s.byField<Task>('tasks', 'conversationId', part.conversationId)) {
          if (
            task.kind ||
            task.botId !== this.state.settings().mainBotId ||
            !s.metadata(`chief-work-managed-task:${task.id}`) ||
            restoredTasks.has(task.id)
          )
            continue;
          const report = this.report(work, task);
          if (!report || known.has(report.id)) continue;
          reports.push(report);
          known.add(report.id);
        }
      }
    }
    for (const task of s.all<Task>('tasks')) {
      if (
        task.trigger?.type !== 'routine' ||
        task.kind ||
        restoredTasks.has(task.id) ||
        !s.metadata(`chief-work-managed-task:${task.id}`)
      )
        continue;
      const routine = s.get<Routine>('routines', task.trigger.routineId);
      if (!routine) continue;
      const report = this.report({ id: routine.id, title: routine.name }, task);
      if (!report || known.has(report.id)) continue;
      reports.push(report);
      known.add(report.id);
    }
    s.setMetadata(this.key, reports);
  }
  private report(work: Pick<ChiefWorkContext, 'id' | 'title'>, task: Task): WorkReport | undefined {
    const s = this.state.storage;
    const ended = terminal(task.status);
    const waiting = ['waiting_input', 'waiting_approval'].includes(task.status);
    const plan = s.get<TaskPlanRecord>('task_plans', task.id);
    const progress = plan
      ? taskPlanView(plan, [task, ...s.byField<Task>('tasks', 'planId', plan.id)], task.botId)
          .steps.filter((step) => step.status === 'completed')
          .map((step) => ({ id: step.id, title: step.title }))
      : [];
    if (!ended && !waiting && !progress.length) return;
    const questions = s
      .byField<UserQuestion>('questions', 'taskId', task.id)
      .filter((question) => question.status === 'pending')
      .map((question) => ({ id: question.id, question: question.question }));
    const revision = {
      status: task.status,
      progress,
      runId: task.runIds.at(-1),
      result: task.result,
      error: task.error,
      questions,
      artifactIds: task.artifactIds,
    };
    const digest = createHash('sha256').update(JSON.stringify(revision)).digest('hex');
    const room = s.get<Conversation>('conversations', task.conversationId);
    if (!room) return;
    const allowed = new Set(
      accessibleArtifacts(this.state, room, task.botId, task).map((item) => item.id),
    );
    const artifactIds = task.artifactIds.filter((artifactId) => {
      const artifact = s.get<Artifact>('artifacts', artifactId);
      return allowed.has(artifactId) && artifact?.purpose !== 'intermediate';
    });
    return {
      id: `${task.id}:${digest}`,
      workId: work.id,
      taskId: task.id,
      status: task.status,
      runId: task.runIds.at(-1),
      content: [
        `后台工作回报：${work.title}`,
        `工作 ID：${work.id}；任务 ID：${task.id}；实际状态：${task.status}`,
        progress.length ? `已完成步骤：${progress.map((step) => step.title).join('、')}` : '',
        task.result ? `结果：${task.result}` : '',
        task.error ? `原因：${task.error}` : '',
        ...questions.map((question) => `待回答问题 ${question.id}：${question.question}`),
        artifactIds.length ? `交付成果 ID：${artifactIds.join('、')}` : '',
        task.trigger?.type === 'routine'
          ? `请按实际状态简短汇报；例行工作 ID：${task.trigger.routineId}。使用 manage_routines 查询或再次运行；活动任务可通过真实任务 ID 补充或停止。`
          : '请依据已保存的实际状态向用户简短汇报；用户有其他请求时先处理用户请求。需要继续时使用原工作 ID。',
      ]
        .filter(Boolean)
        .join('\n'),
      artifactIds,
      createdAt: now(),
    };
  }
  private flush() {
    const s = this.state.storage;
    if (
      s
        .byField<ChiefInput>('chief_inputs', 'homeConversationId', this.contexts.homeId)
        .some((input) => ['pending', 'routing'].includes(input.status))
    )
      return;
    const main = this.contexts.main();
    if (!this.tasks.accepting(main.room.id)) return;
    if (
      s
        .byField<Task>('tasks', 'conversationId', main.room.id)
        .some((task) => !terminal(task.status))
    )
      return;
    const reports = s.metadata<WorkReport[]>(this.key) ?? [];
    const eligible = reports.filter((report) => {
      if (report.deliveredAt || report.suspended) return false;
      const current = s.get<Task>('tasks', report.taskId);
      return (
        current &&
        (!report.status ||
          (current.status === report.status && current.runIds.at(-1) === report.runId))
      );
    });
    const latest = new Map<string, WorkReport>();
    for (const report of eligible) latest.set(report.taskId, report);
    const pending = [...latest.values()].slice(0, 8);
    if (!pending.length) return;
    s.transaction(() => {
      const artifactIds = [...new Set(pending.flatMap((report) => report.artifactIds))].filter(
        (artifactId) => !!s.get<Artifact>('artifacts', artifactId),
      );
      const grantKey = `chief-artifact-grants:${main.room.id}`;
      s.setMetadata(grantKey, [
        ...new Set([...(s.metadata<string[]>(grantKey) ?? []), ...artifactIds]),
      ]);
      const message = s.appendMessage({
        id: id(),
        conversationId: main.room.id,
        authorType: 'system',
        content: pending.map((report) => report.content).join('\n\n'),
        artifactIds,
        status: 'committed',
        createdAt: now(),
      });
      this.tasks.create({
        conversationId: main.room.id,
        botId: this.state.settings().mainBotId!,
        goal: message.content,
        sourceMessageId: message.id,
        inputArtifactIds: artifactIds,
        requestId: `chief-report:${pending.map((report) => report.id).join(':')}`,
      });
      const delivered = new Map(pending.map((report) => [report.taskId, report.id]));
      s.setMetadata(
        this.key,
        reports.map((report) => {
          const selected = delivered.get(report.taskId);
          return selected && !report.deliveredAt && !report.suspended
            ? {
                ...report,
                messageId: message.id,
                deliveredAt: now(),
                ...(selected === report.id ? {} : { supersededBy: selected }),
              }
            : report;
        }),
      );
    });
    this.state.changed();
  }
}
