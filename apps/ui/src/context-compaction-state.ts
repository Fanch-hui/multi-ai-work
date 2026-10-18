import type { Task } from '../../../src/domain/types.js';
import { terminal } from '../../../src/domain/task-status.js';

export type CompactionRequest = 'start' | 'cancel';
export interface CompactionFeedback {
  label: string; detail?: string; busy: boolean; cancellable: boolean;
  tone: 'progress' | 'success' | 'error' | 'neutral';
}

export function latestCompactionTask(tasks: Task[], conversationId: string, response?: Task): Task | undefined {
  const candidates = response?.conversationId === conversationId && response.kind === 'context-compaction' ? [response] : [];
  candidates.push(...tasks.filter(task => task.conversationId === conversationId && task.kind === 'context-compaction'));
  return candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.updatedAt.localeCompare(b.updatedAt)).at(-1);
}

export function compactionFeedback(task?: Task, pending?: CompactionRequest, error = ''): CompactionFeedback | undefined {
  if (pending) return {
    label: pending === 'start' ? '正在准备压缩…' : '正在取消压缩…',
    busy: true, cancellable: pending === 'cancel', tone: 'progress',
  };
  const active = !!task && !terminal(task.status);
  if (error) return { label: '操作失败', detail: error, busy: active, cancellable: active, tone: 'error' };
  if (!task) return;
  if (active) return {
    label: task.status === 'queued' ? '等待压缩…' : '正在压缩…',
    detail: task.status === 'queued' ? '任务已提交，等待可用的执行名额。' : '正在整理较早的对话，请稍候。',
    busy: true, cancellable: true, tone: 'progress',
  };
  if (task.status === 'completed') return {
    label: task.contextCompactionOutcome === 'unchanged' ? '无需压缩' : '压缩完成',
    detail: task.result, busy: false, cancellable: false,
    tone: task.contextCompactionOutcome === 'unchanged' ? 'neutral' : 'success',
  };
  if (task.status === 'cancelled') return {
    label: '已取消压缩', busy: false, cancellable: false, tone: 'neutral',
  };
  return {
    label: task.status === 'interrupted' ? '压缩已中断' : '压缩失败', detail: task.error,
    busy: false, cancellable: false, tone: 'error',
  };
}
