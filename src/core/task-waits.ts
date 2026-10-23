import type { TaskWait } from '../domain/task-wait.js';
import type { Bot, Conversation, Run, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { required } from './errors.js';
import { id, now, type State } from './state.js';

export class TaskWaitPendingError extends Error {
  constructor(readonly wait: TaskWait) {
    super(`${wait.summary}；此操作尚未执行，请处理后继续任务`);
    this.name = 'TaskWaitPendingError';
  }
}

type WaitContext = Pick<ToolExecutionContext, 'task' | 'runId' | 'botId'> & {
  conversation: Pick<Conversation, 'id'>;
};
type WaitInput = Pick<TaskWait, 'kind' | 'summary' | 'resourceId'>;

export class TaskWaitService {
  constructor(private state: State) {}

  forRun(runId: string) {
    return this.state.storage
      .byField<TaskWait>('task_waits', 'runId', runId)
      .find((wait) => wait.status !== 'cancelled');
  }

  pending(runId: string) {
    return this.state.storage
      .byField<TaskWait>('task_waits', 'runId', runId)
      .find((wait) => wait.status === 'pending');
  }

  create(context: WaitContext, input: WaitInput): TaskWait {
    const previous = this.forRun(context.runId);
    if (previous) return previous;
    const s = this.state.storage;
    const task = required(s.get<Task>('tasks', context.task.id), '任务不存在');
    const run = required(s.get<Run>('runs', context.runId), '运行不存在');
    if (run.taskId !== task.id || run.botId !== context.botId)
      throw new Error('等待记录与当前任务不匹配');
    const wait: TaskWait = {
      ...input,
      id: id(),
      taskId: task.id,
      runId: run.id,
      conversationId: context.conversation.id,
      botId: context.botId,
      status: 'pending',
      createdAt: now(),
    };
    s.transaction(() => {
      s.put('task_waits', wait);
      s.put('tasks', { ...task, status: 'waiting_input', updatedAt: now() });
    });
    this.state.changed();
    return wait;
  }

  resume(waitId: string) {
    return this.resolve(waitId, true);
  }

  resourceAvailable(waitId: string) {
    const wait = required(this.state.storage.get<TaskWait>('task_waits', waitId), '等待不存在');
    if (!['browser-resource', 'computer-resource'].includes(wait.kind))
      throw new Error('此等待需要人工继续');
    return this.resolve(waitId, false);
  }

  cancelTask(taskId: string) {
    for (const wait of this.state.storage.byField<TaskWait>('task_waits', 'taskId', taskId)) {
      if (wait.status === 'pending')
        this.state.storage.put('task_waits', { ...wait, status: 'cancelled', resolvedAt: now() });
    }
    this.state.changed();
  }

  private resumeSummary(wait: TaskWait, interactive: boolean) {
    if (wait.kind === 'approval')
      return `用户已选择继续任务：${wait.summary}。请按当前权限重新请求具体操作的审批。`;
    if (wait.kind === 'computer-handoff')
      return `用户已完成电脑接管并确认继续：${wait.summary}。请重新观察窗口后继续任务。`;
    if (wait.kind === 'computer-resource')
      return `桌面工作资源已可用：${wait.summary}。请重新获取并观察授权应用。`;
    if (wait.kind === 'browser-handoff')
      return `用户已完成浏览器接管并确认继续：${wait.summary}。请重新读取页面状态后继续任务。`;
    return `${interactive ? '用户已确认继续任务' : '工作浏览器资源已可用'}：${wait.summary}。请重试获取工作浏览器。`;
  }

  private resolve(waitId: string, interactive: boolean) {
    const s = this.state.storage;
    const wait = required(s.get<TaskWait>('task_waits', waitId), '等待不存在');
    if (wait.status === 'resumed') return wait;
    if (wait.status !== 'pending') throw new Error('等待已取消');
    const task = required(s.get<Task>('tasks', wait.taskId), '任务不存在');
    const room = required(s.get<Conversation>('conversations', wait.conversationId), '会话不存在');
    const bot = required(s.get<Bot>('bots', wait.botId), '智能体不存在');
    if (
      task.status !== 'waiting_input' ||
      room.archived ||
      bot.archived ||
      !room.memberIds.includes(bot.id)
    )
      throw new Error('等待所属任务已停止');
    if (task.reconciliationRequired) throw new Error('请先核查任务中的未知操作');
    const updated: TaskWait = { ...wait, status: 'resumed', resolvedAt: now() };
    s.transaction(() => {
      s.put('task_waits', updated);
      s.appendMessage({
        id: id(),
        conversationId: wait.conversationId,
        authorType: 'system',
        content: this.resumeSummary(wait, interactive),
        artifactIds: [],
        status: 'committed',
        createdAt: now(),
        targetBotIds: [wait.botId],
      });
      const run = s.get<Run>('runs', wait.runId);
      s.put('tasks', {
        ...task,
        status: run?.endedAt ? 'queued' : 'waiting_input',
        interactive: interactive || task.interactive,
        error: undefined,
        updatedAt: now(),
      });
    });
    this.state.changed();
    return updated;
  }
}
