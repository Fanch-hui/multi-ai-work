import type { Run, Task } from '../../../src/domain/types.js';
import type { TaskActivity } from '../../../src/domain/task-activity.js';

const phaseLabels: Record<TaskActivity['phase'], string> = {
  preparing: '准备开始', model: '等待模型响应', recovering: '正在恢复连接', responding: '正在整理答复', tool: '正在执行工具',
  compacting: '正在整理上下文', queued: '排队中', children: '等待成员任务',
  approval: '等待批准', input: '等待回答', stopping: '停止处理中', finished: '运行已结束',
};
const terminalLabels: Record<string, string> = {
  completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断',
};

export function currentActivityLabel(task?: Task, run?: Run): string | undefined {
  if (task && terminalLabels[task.status]) return terminalLabels[task.status];
  if (run?.cancelRequestedAt && !run.endedAt) return '停止处理中';
  const recovery = taskRecovery(task);
  if (recovery) return `正在恢复连接，第 ${recovery.attempt}/${recovery.maxAttempts} 次`;
  return task?.activity ? phaseLabels[task.activity.phase] : undefined;
}

export function activityStalled(task: Task, now: number): boolean {
  if (task.status !== 'running' || !task.activity?.lastActivityAt) return false;
  if (!['preparing', 'model', 'responding', 'tool', 'compacting'].includes(task.activity.phase)) return false;
  return now - Date.parse(task.activity.lastActivityAt) >= 120_000;
}

export function stoppingTask(task: Task, run?: Run): boolean {
  return !terminalLabels[task.status] && (task.activity?.phase === 'stopping' || !!run?.cancelRequestedAt && !run.endedAt);
}

export function taskRecovery(task?: Task): TaskActivity['recovery'] {
  if (task && (terminalLabels[task.status] || task.activity?.phase === 'stopping')) return undefined;
  return task?.status === 'recovering' ? task.recovery
    : task?.activity?.phase === 'recovering' ? task.activity.recovery : undefined;
}

export function recoveryAttemptTime(task?: Task): string | undefined {
  const recovery = taskRecovery(task);
  if (!recovery) return undefined;
  return new Date(recovery.nextAttemptAt).toLocaleTimeString(undefined, { hour12: false });
}

export function recoveryWaitLabel(task: Task, now: number): string | undefined {
  const recovery = taskRecovery(task);
  if (!recovery) return undefined;
  const seconds = Math.max(0, Math.ceil((Date.parse(recovery.nextAttemptAt) - now) / 1_000));
  return seconds > 0 ? `${seconds} 秒后重试` : '即将重试';
}
