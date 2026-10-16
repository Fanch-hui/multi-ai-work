import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import type { Scheduler } from './scheduler.js';
import type { ProcessService } from './processes.js';
import type { Task } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';

type Purpose = 'update' | 'data-directory';

export class MaintenanceAdmission {
  private owner?: Purpose;
  private requests = 0;
  constructor(private state: State, private tasks: TaskService, private scheduler: Scheduler,
    private processes: Pick<ProcessService, 'hasActive'>) {}

  async request<T>(method: string, action: () => Promise<T>): Promise<T> {
    if (method.startsWith('state.')) return action();
    if (this.owner) throw new Error(this.owner === 'update' ? '正在准备安装更新，请稍后操作' : '正在更改数据目录，请稍后操作');
    this.requests++;
    try { return await action(); }
    finally { this.requests--; }
  }

  prepare(purpose: Purpose) {
    if (this.owner === purpose) return { ready: true };
    if (this.owner) throw new Error('应用正在处理其他重启操作，请稍后再试');
    if (this.requests) throw new Error('有操作正在处理，请稍后再试');
    const unfinished = this.state.storage.all<Task>('tasks').some(task => !terminal(task.status));
    if (unfinished || this.scheduler.hasActive() || this.processes.hasActive())
      throw new Error('请先完成或停止所有任务和命令，再重试');
    this.owner = purpose;
    this.tasks.setMaintenanceBlocked(true);
    this.scheduler.pause();
    return { ready: true };
  }

  release(purpose: Purpose) {
    if (this.owner !== purpose) return;
    this.owner = undefined;
    this.tasks.setMaintenanceBlocked(false);
    this.scheduler.resume();
  }
}
