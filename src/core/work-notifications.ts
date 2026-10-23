import type { Task, UserQuestion, Approval } from '../domain/types.js';
import type { TaskWait } from '../domain/task-wait.js';
import type { HostRequest } from './artifact-requests.js';
import type { State } from './state.js';

interface Notice {
  id: string;
  title: string;
  body: string;
  conversationId: string;
}

export class WorkNotifications {
  private unsubscribe?: () => void;
  private pending = new Set<string>();
  private queue = Promise.resolve();
  private stopped = false;
  private observed = '';

  private version() {
    return (['tasks', 'task_waits', 'questions', 'approvals'] as const)
      .map((table) => this.state.storage.tableVersion(table))
      .join(':');
  }

  constructor(
    private state: State,
    private host?: HostRequest,
  ) {}

  start() {
    if (!this.host) return;
    // Existing history is already visible in the workbench; notify subsequent transitions.
    for (const notice of this.notices()) this.mark(notice.id);
    this.observed = this.version();
    this.unsubscribe = this.state.subscribe((kind) => {
      if (kind !== 'state' || this.stopped || this.observed === this.version()) return;
      this.observed = this.version();
      for (const notice of this.notices()) {
        if (this.pending.has(notice.id) || this.state.storage.metadata(`notice:${notice.id}`))
          continue;
        this.pending.add(notice.id);
        this.queue = this.queue.then(async () => {
          if (this.stopped) return;
          try {
            await this.host!('system.notify', { ...notice });
            this.mark(notice.id);
          } catch (error) {
            this.state.storage.setMetadata('notification-error', String(error));
          } finally {
            this.pending.delete(notice.id);
          }
        });
      }
    });
  }

  async close() {
    this.stopped = true;
    this.unsubscribe?.();
    await this.queue;
  }

  private mark(id: string) {
    this.state.storage.setMetadata(`notice:${id}`, true);
  }

  private notices(): Notice[] {
    const s = this.state.storage;
    const notices: Notice[] = [];
    for (const task of s.all<Task>('tasks')) {
      if (
        !task.trigger ||
        task.parentId ||
        !['completed', 'failed', 'interrupted'].includes(task.status)
      )
        continue;
      notices.push({
        id: `task:${task.id}:${task.status}`,
        title: task.status === 'completed' ? '例行工作已完成' : '例行工作需要处理',
        body: task.goal.slice(0, 120),
        conversationId: task.conversationId,
      });
    }
    for (const wait of s.all<TaskWait>('task_waits')) {
      if (wait.status !== 'pending' || wait.kind === 'browser-resource') continue;
      notices.push({
        id: `wait:${wait.id}`,
        title: '有工作等待你处理',
        body: wait.summary.slice(0, 120),
        conversationId: wait.conversationId,
      });
    }
    for (const question of s.all<UserQuestion>('questions')) {
      if (question.status !== 'pending') continue;
      notices.push({
        id: `question:${question.id}`,
        title: '成员需要你的回答',
        body: question.question.slice(0, 120),
        conversationId: question.conversationId,
      });
    }
    for (const approval of s.all<Approval>('approvals')) {
      if (approval.status !== 'pending') continue;
      const task = s.get<Task>('tasks', approval.taskId);
      if (task)
        notices.push({
          id: `approval:${approval.id}`,
          title: '操作等待确认',
          body: approval.summary.slice(0, 120),
          conversationId: task.conversationId,
        });
    }
    return notices;
  }
}
