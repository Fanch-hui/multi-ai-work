import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import type { Scheduler } from './scheduler.js';
import type { ProcessService } from './processes.js';
import type { Task } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';

export class UpdateAdmission {
  private locked = false;
  private requests = 0;
  constructor(private state: State, private tasks: TaskService, private scheduler: Scheduler,
    private processes: Pick<ProcessService, 'hasActive'>) {}

  async request<T>(method: string, action: () => Promise<T>): Promise<T> {
    if (method.startsWith('state.')) return action();
    if (this.locked) throw new Error('正在准备安装更新，请稍后操作');
    this.requests++;
    try { return await action(); }
    finally { this.requests--; }
  }

  prepare() {
    if (this.locked) return { ready: true };
    if (this.requests) throw new Error('有操作正在处理，请稍后重启更新');
    const unfinished = this.state.storage.all<Task>('tasks').some(task => !terminal(task.status));
    if (unfinished || this.scheduler.hasActive() || this.processes.hasActive())
      throw new Error('请先完成或停止所有任务和命令，再重启更新');
    this.locked = true;
    this.tasks.setUpdateBlocked(true);
    this.scheduler.pause();
    return { ready: true };
  }

  release() {
    if (!this.locked) return;
    this.locked = false;
    this.tasks.setUpdateBlocked(false);
    this.scheduler.resume();
  }
}
