import type { Run, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { State } from './state.js';
import type { Scheduler } from './scheduler.js';
import { TaskService, terminal } from './tasks.js';
import { scopedTask } from './task-access.js';
import { TaskInputService } from './task-inputs.js';
import { inspectTask } from './task-inspection.js';
import { id, now } from './state.js';
import { required } from './errors.js';

export interface TaskTarget {
  taskId?: string;
  runId?: string;
}

export class TaskControlService {
  constructor(
    private state: State,
    private tasks: TaskService,
    private scheduler: Scheduler,
  ) {}

  forContext(context: ToolExecutionContext): Partial<ToolExecutionContext> {
    if (
      context.task.kind ||
      context.botId !== this.state.settings().mainBotId ||
      context.conversation.chiefId !== context.botId
    )
      return {};
    return {
      stopTask: async (input) => {
        const target = this.target(context, input);
        let ancestor: Task | undefined = context.task;
        while (ancestor) {
          if (ancestor.id === target.id) throw new Error('请由用户停止当前主管任务');
          ancestor = ancestor.parentId
            ? this.state.storage.get<Task>('tasks', ancestor.parentId)
            : undefined;
        }
        await this.approve(context, 'stop_task', `停止成员任务：${target.id}`, input);
        await this.scheduler.cancel(target.id);
        const current = required(this.state.storage.get<Task>('tasks', target.id), '任务不存在');
        return {
          taskId: current.id,
          cancellationRequested: true,
          stopped: terminal(current.status),
          status: current.status,
          reconciliationRequired: !!current.reconciliationRequired,
        };
      },
      sendTaskInput: async (input) => {
        const target = this.target(context, input);
        if (target.id === context.task.id || target.kind || terminal(target.status))
          throw new Error('请向仍在执行的成员任务补充要求');
        await this.approve(context, 'send_task_input', `引导成员任务：${target.id}`, input);
        const current = required(this.state.storage.get<Task>('tasks', target.id), '任务不存在');
        if (terminal(current.status)) throw new Error('成员任务已结束，请查询结果后安排新任务');
        const artifactIds = [...new Set(input.artifactIds ?? [])];
        if (artifactIds.some((artifactId) => !context.findArtifact(artifactId)))
          throw new Error('任务输入资料未授权');
        const group = this.state.storage.get<typeof context.conversation>(
          'conversations',
          target.conversationId,
        );
        if (group?.sourceConversationId === context.conversation.id && group.sourceTaskId) {
          const groupTask = this.state.storage
            .byField<Task>('tasks', 'parentId', group.sourceTaskId)
            .find((item) => item.conversationId === group.id && item.botId === context.botId);
          if (groupTask)
            this.tasks.update(groupTask, {
              inputArtifactIds: [
                ...new Set([...(groupTask.inputArtifactIds ?? []), ...artifactIds]),
              ],
            });
        }
        const message = this.state.storage.appendMessage({
          id: id(),
          conversationId: target.conversationId,
          authorType: 'bot',
          authorBotId: context.botId,
          content: input.content,
          artifactIds,
          status: 'committed',
          createdAt: now(),
        });
        new TaskInputService(this.state).append(current, message);
        if (current.coordinationPaused)
          this.state.storage.setMetadata(`coordination:${current.id}`, 0);
        this.tasks.update(current, {
          inputArtifactIds: [...new Set([...(current.inputArtifactIds ?? []), ...artifactIds])],
          ...(['waiting_children'].includes(current.status) || current.coordinationPaused
            ? { status: 'queued', coordinationPaused: false }
            : {}),
        });
        return {
          messageId: message.id,
          taskId: current.id,
          status: 'pending',
          newTaskCreated: false,
        };
      },
      reconcileTask: async (input) => {
        const target = this.target(context, input);
        await this.approve(context, 'reconcile_task', `确认任务实际操作：${target.id}`, input);
        return this.reconcile(target.id, input.outcome);
      },
    };
  }

  private target(context: ToolExecutionContext, input: TaskTarget): Task {
    const run = input.runId
      ? required(this.state.storage.get<Run>('runs', input.runId), '运行不存在或未授权')
      : undefined;
    const taskId = input.taskId ?? run?.taskId;
    if (!taskId || (run && input.taskId && run.taskId !== input.taskId))
      throw new Error('任务与运行 ID 不匹配');
    const task = required(
      scopedTask(this.state, context.conversation, context.botId, taskId),
      '任务不存在或未授权',
    );
    if (run && task.runIds.at(-1) !== run.id)
      throw new Error('运行已被后续轮次替代，请查询任务当前运行');
    return task;
  }

  private async approve(
    context: ToolExecutionContext,
    name: string,
    summary: string,
    input: object,
  ) {
    if (!(await context.requestApproval(name, summary, { ...input })))
      throw new Error('任务操作未获批准');
    context.signal.throwIfAborted();
    context.markDispatched?.();
  }

  reconcile(taskId: string, outcome: 'succeeded' | 'not_executed') {
    const s = this.state.storage,
      task = required(s.get<Task>('tasks', taskId), '任务不存在');
    if (!task.reconciliationRequired || !terminal(task.status))
      throw new Error('当前任务不需要对账');
    if (s.byField<Task>('tasks', 'parentId', taskId).some((child) => child.reconciliationRequired))
      throw new Error('请先核查成员任务的未知操作');
    for (const runId of task.runIds) {
      for (const operation of s
        .byField<{ id: string; status: string }>('tool_operations', 'runId', runId)
        .filter((item) => item.status === 'unknown'))
        s.put('tool_operations', {
          ...operation,
          status: outcome === 'succeeded' ? 'succeeded' : 'failed',
          manualConfirmation: now(),
        });
    }
    this.tasks.update(task, {
      status: outcome === 'succeeded' ? 'completed' : 'failed',
      reconciliationRequired: false,
      error: outcome === 'succeeded' ? undefined : '已核查，操作未执行，可重试。',
    });
    return {
      confirmed: true,
      task: inspectTask(this.state, required(s.get<Task>('tasks', taskId), '任务不存在')),
    };
  }
}
