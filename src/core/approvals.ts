import type { Approval, Bot, Run, Task } from '../domain/types.js';
import { State, id, now } from './state.js';
import { required } from './errors.js';

export class ApprovalService {
  private pending = new Map<string, (approved: boolean) => void>();
  constructor(private state: State) {}
  async request(run: Run, toolName: string, summary: string, args: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const bot = required(this.state.storage.get<Bot>('bots', run.botId), '智能体不存在');
    if (bot.archived) throw new Error('智能体已归档');
    if (bot.approvalMode === 'auto') return true;
    const approval: Approval = { id: id(), runId: run.id, taskId: run.taskId, botId: run.botId,
      toolName, summary, args, status: 'pending', createdAt: now() };
    this.state.storage.put('approvals', approval);
    this.status(run, 'waiting_approval');
    return new Promise<boolean>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(approval.id);
        this.state.storage.put('approvals', { ...approval, status: 'rejected' });
        this.state.changed(); reject(new DOMException('运行已取消', 'AbortError'));
      };
      this.pending.set(approval.id, approved => {
        signal.removeEventListener('abort', abort);
        this.status(run, 'running'); resolve(approved);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.state.changed();
    });
  }
  resolve(id: string, approved: boolean) {
    const approval = required(this.state.storage.get<Approval>('approvals', id), '审批不存在');
    const handler = this.pending.get(id);
    if (approval.status !== 'pending' || !handler) throw new Error('审批所属运行已结束，请重新执行任务');
    this.state.storage.put('approvals', { ...approval, status: approved ? 'approved' : 'rejected' });
    this.pending.delete(id); handler(approved); this.state.changed();
  }
  private status(run: Run, status: 'running' | 'waiting_approval') {
    const current = this.state.storage.get<Run>('runs', run.id);
    const task = this.state.storage.get<Task>('tasks', run.taskId);
    if (current) this.state.storage.put('runs', { ...current, status });
    if (task) this.state.storage.put('tasks', { ...task, status, updatedAt: now() });
    this.state.changed();
  }
}
