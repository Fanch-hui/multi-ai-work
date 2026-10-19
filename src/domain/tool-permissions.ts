import type { ApprovalMode } from './types.js';

export const memberToolNames = [
  'post_message',
  'read_messages',
  'get_task',
  'recall_memory',
  'propose_memory',
  'read_file',
  'read_artifact',
  'write_artifact',
  'list_directory',
  'find_files',
  'search_text',
  'write_file',
  'edit_file',
  'list_artifacts',
  'register_artifact',
  'search_messages',
  'fetch_web',
  'search_web',
  'ask_user',
  'read_skill',
  'load_workspace_dependencies',
];
export const taskPlanToolNames = ['set_task_plan', 'get_task_plan', 'update_plan_step'];
export const taskControlToolNames = ['send_task_input', 'stop_task', 'reconcile_task'];
export const chiefToolNames = [
  ...memberToolNames,
  ...taskPlanToolNames,
  ...taskControlToolNames,
  'delegate_task',
  'list_bots',
  'configure_bot',
  'create_task_group',
  'manage_memory',
  'run_command',
  'list_processes',
  'read_process',
  'stop_process',
  'render_document',
];
export const chiefOnlyTools = [
  'delegate_task',
  'list_bots',
  'configure_bot',
  'create_task_group',
  ...taskPlanToolNames,
  ...taskControlToolNames,
];

export const toolPermissionGroups = [
  {
    id: 'conversation',
    label: '会话与问答',
    hint: '发言、读取历史、查询进展和向你提问。',
    tools: ['post_message', 'read_messages', 'search_messages', 'get_task', 'ask_user'],
  },
  {
    id: 'read',
    label: '读取资料',
    hint: '查找、搜索、读取工作目录文件和获准成果。',
    tools: [
      'list_directory',
      'find_files',
      'search_text',
      'read_file',
      'read_artifact',
      'list_artifacts',
      'load_workspace_dependencies',
    ],
  },
  {
    id: 'write',
    label: '文件与成果',
    hint: '创建、修改、删除文件及生成成果。',
    tools: ['write_file', 'edit_file', 'write_artifact', 'register_artifact', 'delete_file'],
  },
  {
    id: 'web',
    label: '网页检索',
    hint: '读取公共网页，使用已授权的搜索服务。',
    tools: ['fetch_web', 'search_web'],
  },
  {
    id: 'command',
    label: '命令执行',
    hint: '执行命令，查看输出并停止本任务的命令。',
    tools: ['run_command', 'list_processes', 'read_process', 'stop_process', 'render_document'],
  },
  {
    id: 'external',
    label: '外部工具',
    hint: '使用下方单独授权的外部连接。',
    tools: ['list_mcp_tools', 'call_mcp'],
  },
  {
    id: 'team',
    label: '团队管理',
    hint: '管家编排工作、创建任务群、委派任务和配置成员。',
    tools: chiefOnlyTools,
  },
];
const supportingTools = ['recall_memory', 'propose_memory', 'read_skill'];

export function permissionGroups(chief: boolean) {
  return toolPermissionGroups.filter((group) => chief || group.id !== 'team');
}
export function defaultToolNames(chief: boolean): string[] {
  return [...(chief ? chiefToolNames : memberToolNames)];
}
export function fullToolNames(chief: boolean): string[] {
  return [
    ...new Set([
      ...permissionGroups(chief).flatMap((group) => group.tools),
      ...supportingTools,
      ...(chief ? ['manage_memory'] : []),
    ]),
  ];
}
export function readOnlyToolNames(chief: boolean): string[] {
  return [
    ...new Set([
      ...toolPermissionGroups
        .filter((group) => ['conversation', 'read', 'web'].includes(group.id))
        .flatMap((group) => group.tools),
      'recall_memory',
      'read_skill',
      ...(chief ? ['list_bots', 'get_task_plan'] : []),
    ]),
  ];
}
export type PermissionPreset = 'read' | 'common' | 'full' | 'custom';
export function permissionPreset(
  names: string[],
  mode: ApprovalMode,
  chief: boolean,
): PermissionPreset {
  const same = (expected: string[]) =>
    names.length === expected.length && expected.every((name) => names.includes(name));
  if (mode === 'auto' && same(fullToolNames(chief))) return 'full';
  if (mode === 'ask' && same(defaultToolNames(chief))) return 'common';
  if (mode === 'ask' && same(readOnlyToolNames(chief))) return 'read';
  return 'custom';
}
export function hasFullToolAccess(names: string[], chief: boolean): boolean {
  return fullToolNames(chief)
    .filter((name) => name !== 'manage_memory')
    .every((name) => names.includes(name));
}
