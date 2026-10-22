import type { RunEvent, Snapshot, Task } from '../../../src/domain/types.js';

export interface RecordedAction {
  key: string;
  event: RunEvent;
  title: string;
  status: string;
}

const toolLabels: Record<string, string> = {
  list_directory: '查看目录',
  find_files: '查找文件',
  search_text: '搜索文件内容',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  delete_file: '删除文件',
  read_artifact: '读取成果',
  write_artifact: '生成成果',
  list_artifacts: '查找成果',
  register_artifact: '登记成果',
  read_messages: '读取消息',
  search_messages: '搜索消息',
  run_command: '执行命令',
  list_processes: '查看命令',
  read_process: '读取命令输出',
  stop_process: '停止命令',
  ask_user: '向你提问',
  fetch_web: '读取网页',
  search_web: '搜索网页',
  post_message: '发表消息',
  delegate_task: '派发任务',
  create_task_group: '创建任务群',
  get_task: '读取任务状态',
  set_task_plan: '编排任务',
  get_task_plan: '读取任务安排',
  update_plan_step: '记录安排进展',
  list_bots: '查看团队成员',
  configure_bot: '配置成员',
  recall_memory: '检索记忆',
  propose_memory: '保存记忆',
  manage_memory: '管理记忆',
  read_skill: '读取技能',
  list_mcp_tools: '查看外部工具',
  call_mcp: '调用外部工具',
};

export function toolActionTitle(name: string, summary?: string): string {
  return summary?.trim() || toolLabels[name] || `使用工具 ${name}`;
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const phaseLabels: Record<string, string> = {
  'cancel-requested': '正在停止工作',
  'model-retry': '正在恢复连接',
  'model-recovery': '正在恢复连接',
  'model-recovery-wait': '等待恢复连接',
  'model-error': '模型处理遇到问题',
  waiting_input: '等待你的回答',
  waiting_children: '等待成员返回结果',
  waiting_approval: '等待批准',
  recovering: '正在恢复连接',
  resumed: '继续处理已保存的工作',
  interrupted: '工作已中断',
  stopping: '正在停止工作',
  cancelled: '工作已取消',
  'model-waiting': '等待模型处理',
  'waiting-children': '等待成员返回结果',
  'waiting-input': '等待你的回答',
  'waiting-approval': '等待批准',
  'checkpoint-restored': '已恢复工作进度',
  'checkpoint-resumed': '继续处理已保存的工作',
  'reconciliation-required': '操作结果待核查',
};

export function taskRecordActions(
  data: Pick<Snapshot, 'runs' | 'events'>,
  task: Task,
): RecordedAction[] {
  const runs = new Map(
    data.runs.filter((run) => run.taskId === task.id).map((run) => [run.id, run]),
  );
  const actions = new Map<string, RunEvent>();
  const compactions = new Map<string, string>();
  for (const event of [...data.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!runs.has(event.runId) || !isWorkEvent(event)) continue;
    let key = workActionKey(event);
    if (event.type === 'compaction') {
      if (event.data.status === 'started') compactions.set(event.runId, key);
      else if (event.data.status !== undefined) key = compactions.get(event.runId) ?? key;
    }
    actions.set(key, mergeAction(actions.get(key), event));
  }
  return [...actions]
    .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))
    .map(([key, event]) => {
      const status = String(event.data.status ?? '');
      if (event.type === 'compaction')
        return {
          key,
          event,
          title: '整理工作上下文',
          status:
            event.data.owner === 'native' && !status
              ? '已完成'
              : statusLabel(status, runs.get(event.runId)?.endedAt),
        };
      if (event.type !== 'tool')
        return {
          key,
          event,
          title:
            typeof event.data.summary === 'string'
              ? event.data.summary
              : phaseLabels[String(event.data.phase)] || '等待处理',
          status: event.type === 'approval' ? '需要批准' : '',
        };
      const name = typeof event.data.name === 'string' ? event.data.name : '外部工具';
      return {
        key,
        event,
        title: toolActionTitle(
          name,
          typeof event.data.summary === 'string' ? event.data.summary : undefined,
        ),
        status: statusLabel(status, runs.get(event.runId)?.endedAt),
      };
    });
}

export function isWorkEvent(event: RunEvent): boolean {
  return (
    ['tool', 'compaction', 'approval'].includes(event.type) ||
    (event.type === 'status' &&
      event.data.scope !== 'compaction' &&
      String(event.data.phase) in phaseLabels)
  );
}

export function workActionKey(event: RunEvent): string {
  if (event.type === 'tool' && typeof event.data.callId === 'string')
    return `${event.runId}:tool:${event.data.callId}`;
  if (event.type === 'compaction') return `${event.runId}:compaction:${event.id}`;
  return `${event.runId}:${event.id}`;
}

function statusLabel(status: string, endedAt?: string): string {
  if (status === 'completed') return '已完成';
  if (status === 'unchanged') return '保留原上下文';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'running' && !endedAt) return '执行中';
  return '结果未报告';
}

function mergeAction(previous: RunEvent | undefined, event: RunEvent): RunEvent {
  let status = event.data.status;
  if (status === 'started' || (status === undefined && event.data.phase === 'started'))
    status = 'running';
  if (status === undefined && event.data.phase === 'completed') status = 'completed';
  const data = { ...previous?.data, ...event.data, status };
  if (
    previous?.data.status &&
    (status === undefined ||
      (terminalStatuses.has(String(previous.data.status)) &&
        !terminalStatuses.has(String(status))) ||
      (event.data.source !== 'app' &&
        previous.data.source === 'app' &&
        terminalStatuses.has(String(previous.data.status))))
  ) {
    data.status = previous.data.status;
  }
  return { ...event, data };
}
