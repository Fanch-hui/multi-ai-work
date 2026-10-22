import type { Conversation, ProcessRecord, Snapshot, Task } from '../../../src/domain/types.js';
export { taskRecordActions, toolActionTitle } from './run-work-actions.js';
export type { RecordedAction } from './run-work-actions.js';
import { currentActivityLabel, recoveryAttemptTime } from './task-activity.js';

const activeStatuses = new Set([
  'recovering',
  'queued',
  'running',
  'waiting_children',
  'waiting_approval',
  'waiting_input',
]);
const taskLabels: Record<string, string> = {
  recovering: '正在恢复连接',
  queued: '排队中',
  running: '思考中',
  waiting_children: '等待成员',
  waiting_approval: '等待批准',
  waiting_input: '等待你的回答',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const processLabels: Record<string, string> = {
  running: '命令运行中',
  completed: '命令已完成',
  failed: '命令失败',
  stopped: '命令已停止',
  timed_out: '命令超时',
  unknown: '命令结果待核查',
};

export function conversationRecordTasks(
  data: Pick<Snapshot, 'tasks' | 'conversations'>,
  conversation: Conversation,
): Task[] {
  const included = new Set(
    data.tasks.filter((task) => task.conversationId === conversation.id).map((task) => task.id),
  );
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  const rooms = new Map(data.conversations.map((room) => [room.id, room]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of data.tasks) {
      if (included.has(task.id) || !task.parentId || !included.has(task.parentId)) continue;
      const parent = tasks.get(task.parentId)!;
      const room = rooms.get(task.conversationId);
      if (
        task.conversationId !== parent.conversationId &&
        (room?.sourceConversationId !== parent.conversationId || room.sourceTaskId !== parent.id)
      )
        continue;
      included.add(task.id);
      changed = true;
    }
  }
  return data.tasks
    .filter((task) => included.has(task.id))
    .sort(
      (a, b) =>
        Number(activeStatuses.has(b.status)) - Number(activeStatuses.has(a.status)) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}

export interface MemberRecords {
  botId: string;
  tasks: Task[];
  background: Task[];
  active: number;
  failed: number;
}
export function conversationMemberRecords(tasks: Task[], memberIds: string[]): MemberRecords[] {
  const byMember = new Map<string, Task[]>();
  for (const task of tasks) {
    const records = byMember.get(task.botId) ?? [];
    records.push(task);
    byMember.set(task.botId, records);
  }
  return [...new Set([...memberIds, ...byMember.keys()])]
    .filter((id) => byMember.has(id))
    .map((botId) => {
      const records = byMember.get(botId)!;
      const work = records.filter((task) => !task.kind);
      return {
        botId,
        tasks: work,
        background: records.filter((task) => !!task.kind),
        active: work.filter(recordTaskActive).length,
        failed: work.filter((task) => task.status === 'failed').length,
      };
    });
}

export const recordTaskTitle = (task: Task): string => {
  if (task.kind === 'memory-review') {
    return '整理长期记忆';
  }
  if (task.kind === 'question-decision') {
    return '为成员的问题提供回答';
  }
  return task.goal;
};

export function taskRecordStatus(task: Task, processes: ProcessRecord[]): string {
  const nextAttempt = recoveryAttemptTime(task);
  if (nextAttempt) return `${currentActivityLabel(task)} · 下次尝试 ${nextAttempt}`;
  if (task.coordinationPaused && task.status === 'waiting_input') return '等待继续';
  if (task.status === 'queued')
    return (
      (
        {
          global_limit: '等待空闲名额',
          account_limit: '等待连接空闲',
          session_busy: '等待上一轮',
          dependencies: '等待前置任务',
        } as Record<string, string>
      )[task.queueReason ?? ''] ?? '准备开始'
    );
  if (
    task.status === 'running' &&
    processes.some((process) => process.taskId === task.id && process.status === 'running')
  )
    return '执行命令中';
  if (task.kind === 'memory-review' && task.status === 'running') return '后台整理记忆';
  return taskLabels[task.status] ?? task.status;
}
export const processRecordStatus = (process: ProcessRecord): string =>
  processLabels[process.status] ?? process.status;
export const recordTaskActive = (task: Task): boolean => activeStatuses.has(task.status);
