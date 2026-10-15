import type { Conversation, ProcessRecord, RunEvent, Snapshot, Task } from '../../../src/domain/types.js';
import { currentActivityLabel, recoveryAttemptTime } from './task-activity.js';

const activeStatuses = new Set(['recovering', 'queued', 'running', 'waiting_children', 'waiting_approval', 'waiting_input']);
const taskLabels: Record<string, string> = {
  recovering: '正在恢复连接', queued: '排队中', running: '思考中', waiting_children: '等待成员', waiting_approval: '等待批准',
  waiting_input: '等待你的回答', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
const processLabels: Record<string, string> = {
  running: '命令运行中', completed: '命令已完成', failed: '命令失败', stopped: '命令已停止',
  timed_out: '命令超时', unknown: '命令结果待核查',
};
const toolLabels: Record<string, string> = {
  list_directory: '查看目录', find_files: '查找文件', search_text: '搜索文件内容', read_file: '读取文件',
  write_file: '写入文件', edit_file: '修改文件', delete_file: '删除文件', read_artifact: '读取成果',
  write_artifact: '生成成果', list_artifacts: '查找成果', register_artifact: '登记成果',
  read_messages: '读取消息', search_messages: '搜索消息', run_command: '执行命令',
  list_processes: '查看命令', read_process: '读取命令输出', stop_process: '停止命令',
  ask_user: '向你提问', fetch_web: '读取网页', search_web: '搜索网页', post_message: '发表消息',
  delegate_task: '派发任务', create_task_group: '创建任务群', get_task: '读取任务状态',
  set_task_plan: '编排任务', get_task_plan: '读取任务安排', update_plan_step: '记录安排进展',
  list_bots: '查看团队成员', configure_bot: '配置成员',
  recall_memory: '检索记忆', propose_memory: '保存记忆', manage_memory: '管理记忆',
  read_skill: '读取技能', list_mcp_tools: '查看外部工具', call_mcp: '调用外部工具',
};

export function conversationRecordTasks(data: Pick<Snapshot, 'tasks' | 'conversations'>, conversation: Conversation): Task[] {
  const included = new Set(data.tasks.filter(task => task.conversationId === conversation.id).map(task => task.id));
  const tasks = new Map(data.tasks.map(task => [task.id, task]));
  const rooms = new Map(data.conversations.map(room => [room.id, room]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of data.tasks) {
      if (included.has(task.id) || !task.parentId || !included.has(task.parentId)) continue;
      const parent = tasks.get(task.parentId)!;
      const room = rooms.get(task.conversationId);
      if (task.conversationId !== parent.conversationId
        && (room?.sourceConversationId !== parent.conversationId || room.sourceTaskId !== parent.id)) continue;
      included.add(task.id); changed = true;
    }
  }
  return data.tasks.filter(task => included.has(task.id)).sort((a, b) =>
    Number(activeStatuses.has(b.status)) - Number(activeStatuses.has(a.status))
    || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export interface RecordedAction { event: RunEvent; title: string; status: string; }
export interface MemberRecords { botId: string; tasks: Task[]; background: Task[]; active: number; failed: number; }
export function conversationMemberRecords(tasks: Task[], memberIds: string[]): MemberRecords[] {
  const byMember = new Map<string, Task[]>();
  for (const task of tasks) {
    const records = byMember.get(task.botId) ?? [];
    records.push(task); byMember.set(task.botId, records);
  }
  return [...new Set([...memberIds, ...byMember.keys()])].filter(id => byMember.has(id)).map(botId => {
    const records = byMember.get(botId)!;
    const work = records.filter(task => !task.kind);
    return { botId, tasks: work, background: records.filter(task => !!task.kind),
      active: work.filter(recordTaskActive).length, failed: work.filter(task => task.status === 'failed').length };
  });
}

export const recordTaskTitle = (task: Task): string => task.kind === 'memory-review' ? '整理长期记忆'
  : task.kind === 'question-decision' ? '为成员的问题提供回答' : task.goal;
export function taskRecordActions(data: Pick<Snapshot, 'runs' | 'events'>, task: Task): RecordedAction[] {
  const runs = new Map(data.runs.filter(run => run.taskId === task.id).map(run => [run.id, run]));
  const actions = new Map<string, RunEvent>();
  for (const event of [...data.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!runs.has(event.runId) || !['tool', 'compaction'].includes(event.type)) continue;
    const key = event.type === 'tool' && typeof event.data.callId === 'string'
      ? `${event.runId}:${event.data.callId}` : event.id;
    const previous = actions.get(key);
    actions.set(key, mergeAction(previous, event));
  }
  return [...actions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(event => {
    if (event.type === 'compaction') return { event, title: '整理工作上下文', status: '' };
    const name = typeof event.data.name === 'string' ? event.data.name : '工具操作';
    const summary = typeof event.data.summary === 'string' ? event.data.summary : '';
    const status = event.data.status;
    const commandStatus = typeof event.data.commandStatus === 'string' ? processLabels[event.data.commandStatus] : undefined;
    return { event, title: summary || toolLabels[name] || name,
      status: commandStatus ?? (status === 'completed' ? '已完成' : status === 'failed' ? '失败'
        : status === 'running' && !runs.get(event.runId)?.endedAt ? '执行中' : '结果未报告') };
  });
}

function mergeAction(previous: RunEvent | undefined, event: RunEvent): RunEvent {
  const status = event.data.status ?? (event.data.phase === 'completed' ? 'completed'
    : event.data.phase === 'started' ? 'running' : undefined);
  const data = { ...previous?.data, ...event.data, status };
  if (previous?.data.status && (status === undefined ||
    (event.data.source !== 'app' && previous.data.source === 'app'
      && ['completed', 'failed'].includes(String(previous.data.status))))) data.status = previous.data.status;
  return { ...event, data };
}

export function taskRecordStatus(task: Task, processes: ProcessRecord[]): string {
  const nextAttempt = recoveryAttemptTime(task);
  if (nextAttempt) return `${currentActivityLabel(task)} · 下次尝试 ${nextAttempt}`;
  if (task.coordinationPaused && task.status === 'waiting_input') return '等待继续';
  if (task.status === 'queued') return ({ global_limit: '等待空闲名额', account_limit: '等待连接空闲',
    session_busy: '等待上一轮', dependencies: '等待前置任务' } as Record<string, string>)[task.queueReason ?? ''] ?? '准备开始';
  if (task.status === 'running' && processes.some(process => process.taskId === task.id && process.status === 'running')) return '执行命令中';
  if (task.kind === 'memory-review' && task.status === 'running') return '后台整理记忆';
  return taskLabels[task.status] ?? task.status;
}
export const processRecordStatus = (process: ProcessRecord): string => processLabels[process.status] ?? process.status;
export const recordTaskActive = (task: Task): boolean => activeStatuses.has(task.status);
