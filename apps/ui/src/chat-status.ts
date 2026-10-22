import type { ProcessRecord, Run, RunEvent, Task } from '../../../src/domain/types.js';
import { currentActivityLabel, recoveryAttemptTime } from './task-activity.js';

const phrases = {
  preparing: ['正在做准备', '正在整理手头资料', '准备开工', '正在理清任务要求'],
  thinking: [
    '正在梳理思路',
    '正把线索串起来',
    '正在琢磨下一步',
    '换个角度想一想',
    '正在理顺关键细节',
  ],
  working: [
    '正在着手处理',
    '正在逐项推进',
    '正忙着把事情做扎实',
    '正在处理手头工作',
    '正在把细节落到实处',
  ],
  responding: ['正在组织回复', '正在把结果整理清楚', '正在理顺表达', '准备把成果交给你'],
  compacting: ['正在整理工作笔记', '把前面的线索归拢一下', '正在收拢上下文'],
  finishing: ['正在收尾', '正在整理最后的结果', '正在完成本轮处理'],
} as const;
type ChatPhase = keyof typeof phrases;

function phrase(phase: ChatPhase, task?: Task, run?: Run, key?: string): string {
  const ordinal = key?.match(/:(\d+)$/)?.[1];
  const base = `${task?.id ?? run?.taskId ?? run?.id ?? ''}:${phase}`;
  const seed = ordinal === undefined ? `${base}:${key ?? run?.id ?? ''}` : base;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++)
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  const pool = phrases[phase];
  const offset = ordinal === undefined ? 0 : Number(ordinal) % pool.length;
  return pool[((hash >>> 0) + offset) % pool.length];
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function modelHasStarted(
  task: Task | undefined,
  run: Run | undefined,
  events: RunEvent[],
): boolean {
  if (task?.activity?.firstModelOutputAt) return true;
  const runIds = new Set(task?.runIds ?? (run ? [run.id] : []));
  return events.some((event) => {
    if (!runIds.has(event.runId) || event.data.scope === 'compaction') return false;
    if (event.type === 'text')
      return (
        !Object.hasOwn(event.data, 'replace') &&
        (nonempty(event.data.delta) || nonempty(event.data.text))
      );
    if (event.type === 'tool') return nonempty(event.data.name);
    if (event.type !== 'status') return false;
    if (event.data.phase === 'model-work-started') return true;
    return nonempty(event.data.reasoning) || nonempty(event.data.thinking);
  });
}

function projectedPhase(task: Task): ChatPhase | 'waiting' | undefined {
  const activity = task.activity;
  if (!activity) return undefined;
  if (activity.phase === 'tool') return 'working';
  if (activity.phase !== 'model') {
    if (['preparing', 'responding', 'compacting'].includes(activity.phase))
      return activity.phase as ChatPhase;
    return undefined;
  }
  const kind = activity.modelActivity ?? 'waiting';
  return kind === 'tool' ? 'working' : kind;
}

function relevantEvents(events: RunEvent[], run?: Run): RunEvent[] {
  return events
    .filter(
      (event) =>
        event.runId === run?.id &&
        event.data.scope !== 'compaction' &&
        !(event.type === 'text' && Object.hasOwn(event.data, 'replace')) &&
        !(
          event.type === 'status' &&
          [
            'model-cache-request',
            'model-cache-response',
            'performance',
            'model-work-started',
          ].includes(String(event.data.phase))
        ),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function chatActivityLabel(
  task?: Task,
  run?: Run,
  events: RunEvent[] = [],
  streaming = false,
  processes: ProcessRecord[] = [],
): string {
  const projected = task && projectedPhase(task);
  const label = currentActivityLabel(task, run);
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(
    task?.status ?? run?.status ?? '',
  );
  if (
    label &&
    (!projected || terminal || label === '停止处理中' || task?.status === 'recovering')
  ) {
    const nextAttempt = recoveryAttemptTime(task);
    return nextAttempt ? `${label} · 下次尝试 ${nextAttempt}` : label;
  }
  const choose = (phase: ChatPhase, key = task?.activity?.activityKey) =>
    phrase(phase, task, run, key);
  if (task?.activity?.phase === 'model' && !modelHasStarted(task, run, events))
    return '正在等待响应';
  if (projected === 'waiting')
    return modelHasStarted(task, run, events) ? choose('thinking') : '正在等待响应';
  if (projected) return choose(projected);
  const status = task?.status ?? run?.status;
  if (status === 'queued') return '排队中';
  if (status === 'waiting_approval' || run?.status === 'waiting_approval') return '等待你的批准';
  if (status === 'waiting_input' || run?.status === 'waiting_input') return '等待你的回答';
  if (status === 'waiting_children') return '等待成员任务';
  const process = processes.find((item) => item.runId === run?.id && item.status === 'running');
  if (process) return choose('working', process.id);
  const recent = relevantEvents(events, run);
  const tools = new Map<string, RunEvent>();
  for (const event of recent) {
    if (event.type === 'tool') tools.set(String(event.data.callId ?? event.data.name), event);
  }
  const active = [...tools.values()].find((event) =>
    ['started', 'running'].includes(String(event.data.status ?? event.data.phase)),
  );
  if (active) return choose('working', String(active.data.callId ?? active.id));
  const latest = recent
    .filter((event) => ['status', 'compaction', 'tool', 'text'].includes(event.type))
    .at(-1);
  if (latest?.data.phase === 'model-retry') return '正在恢复连接';
  if (latest?.type === 'compaction' && latest.data.status === 'started')
    return choose('compacting', latest.id);
  const request = recent.filter((event) => event.data.phase === 'model-request').at(-1);
  if (streaming && (!recent.length || recent.at(-1)?.type === 'text'))
    return choose('responding', request?.id);
  if (request && !modelHasStarted(task, run, events)) return '正在等待响应';
  return choose(
    recent.length || modelHasStarted(task, run, events) ? 'thinking' : 'preparing',
    request?.id,
  );
}
