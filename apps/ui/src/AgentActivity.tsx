import type { ProcessRecord, Run, RunEvent, Task } from '../../../src/domain/types.js';
import { cn } from './classNames.js';
import { currentActivityLabel, recoveryAttemptTime } from './task-activity.js';

export function agentActivity(task?: Task, run?: Run, events: RunEvent[] = [], streaming = false, processes: ProcessRecord[] = []): string {
  const status = task?.status ?? run?.status;
  const activity = currentActivityLabel(task, run);
  const nextAttempt = recoveryAttemptTime(task);
  if (activity) return nextAttempt ? `${activity} · 下次尝试 ${nextAttempt}` : activity;
  if (status === 'queued') return '排队中';
  if (status === 'waiting_approval' || run?.status === 'waiting_approval') return '等待你的批准';
  if (status === 'waiting_input' || run?.status === 'waiting_input') return '等待你的回答';
  if (status === 'waiting_children') return '正在协调团队';
  if (processes.some(process => process.runId === run?.id && process.status === 'running')) return '命令运行中';
  const recent = events.filter(event => event.runId === run?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const tools = new Map<string, string>();
  for (const event of recent) {
    if (event.type !== 'tool') continue;
    const toolStatus = event.data.status ?? event.data.phase;
    if (toolStatus) tools.set(String(event.data.callId ?? event.data.name), String(toolStatus));
  }
  if ([...tools.values()].some(status => ['started', 'running'].includes(status))) return '正在工作中';
  const latest = recent.filter(event => ['status', 'compaction', 'tool', 'text'].includes(event.type)).at(-1);
  if (latest?.data.phase === 'model-retry') return '正在恢复连接';
  if (latest?.type === 'compaction' && latest.data.status === 'started') return '正在整理上下文';
  if (streaming && (!recent.length || recent.at(-1)?.type === 'text')) return '正在为你整理答复';
  return '思考中';
}

export function AgentActivity({ label, animated = true, className }: { label: string; animated?: boolean; className?: string }) {
  return <span role="status" className={cn('agent-activity inline-flex items-center gap-2 text-xs text-slate-400', className)}>
    <span aria-hidden="true" className={cn('agent-activity-indicator', animated && 'agent-activity-animated')}><i /><i /><i /></span>
    <span key={label} className="agent-activity-label">{label}</span>
  </span>;
}
