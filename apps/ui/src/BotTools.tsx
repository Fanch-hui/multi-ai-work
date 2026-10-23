import { useRef, useState } from 'react';
import type { ApprovalMode, QoderService, Snapshot } from '../../../src/domain/types.js';
import {
  enabledQoderServices,
  qoderServices as serviceOptions,
} from '../../../src/domain/qoder-services.js';
import {
  chiefOnlyTools,
  defaultToolNames,
  fullToolNames,
  permissionGroups,
  permissionPreset,
  readOnlyToolNames,
  type PermissionPreset,
} from '../../../src/domain/tool-permissions.js';
import { Field, inputClass } from './components.js';
export const builtinToolLabels: Record<string, string> = {
  post_message: '向会话发送消息',
  read_messages: '读取会话消息',
  search_messages: '搜索会话消息',
  delegate_task: '委派成员任务',
  get_task: '查询任务进展',
  list_bots: '查看团队成员',
  configure_bot: '配置团队成员',
  create_task_group: '创建任务群聊',
  set_task_plan: '编排任务步骤',
  get_task_plan: '查看任务安排',
  update_plan_step: '记录安排进展',
  recall_memory: '检索长期记忆',
  propose_memory: '保存长期记忆',
  manage_memory: '管理长期记忆',
  read_artifact: '读取成果',
  list_artifacts: '查看成果列表',
  register_artifact: '登记生成的成果',
  list_directory: '列出工作目录',
  find_files: '查找文件',
  search_text: '搜索文件内容',
  read_file: '读取工作目录文件',
  write_file: '创建与更新文本文件',
  edit_file: '编辑文本文件',
  write_artifact: '创建与更新成果',
  delete_file: '删除文件',
  run_command: '执行命令',
  list_processes: '查看本任务命令',
  read_process: '读取命令输出',
  stop_process: '停止本任务命令',
  ask_user: '向用户提问',
  fetch_web: '读取网页',
  search_web: '搜索互联网',
  list_mcp_tools: '查询外部工具目录',
  call_mcp: '调用外部工具',
  read_skill: '读取 Skill',
  manage_routines: '管理例行工作',
  browser_open: '打开工作浏览器',
  browser_snapshot: '读取浏览器页面',
  browser_action: '操作浏览器页面',
  browser_tabs: '管理浏览器标签',
  browser_handoff: '请求用户接管浏览器',
  record_artifact_review: '记录成果复核',
};
type ToolPermissionsProps = {
  toolNames: string[];
  approvalMode: ApprovalMode;
  onPermissionsChange: (value: { toolNames: string[]; approvalMode: ApprovalMode }) => void;
  chief: boolean;
};
const toggle = (items: string[], value: string) =>
  items.includes(value) ? items.filter((item) => item !== value) : [...items, value];

function PermissionControls({
  toolNames,
  approvalMode,
  onPermissionsChange,
  chief,
}: ToolPermissionsProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const preset = permissionPreset(toolNames, approvalMode, chief);
  const [customizing, setCustomizing] = useState(false);
  function selectPreset(value: PermissionPreset) {
    if (value === 'custom') {
      setCustomizing(true);
      if (details.current) details.current.open = true;
      return;
    }
    setCustomizing(false);
    const getSelectedToolNames = () => {
      if (value === 'full') {
        return fullToolNames(chief);
      }
      if (value === 'read') {
        return readOnlyToolNames(chief);
      }
      return defaultToolNames(chief);
    };
    onPermissionsChange({
      toolNames: getSelectedToolNames(),
      approvalMode: value === 'full' ? 'auto' : 'ask',
    });
  }
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="权限方案">
          <select
            className={inputClass}
            value={customizing ? 'custom' : preset}
            onChange={(event) => selectPreset(event.target.value as PermissionPreset)}
          >
            <option value="read">只读</option>
            <option value="common">常用</option>
            <option value="full">完整</option>
            <option value="custom">自定义</option>
          </select>
        </Field>
        <Field
          label="执行方式"
          hint={
            approvalMode === 'auto'
              ? '已授权操作直接执行。'
              : '覆盖原文件、删除、执行命令等操作需要你审批。'
          }
        >
          <select
            className={inputClass}
            value={approvalMode}
            onChange={(event) =>
              onPermissionsChange({ toolNames, approvalMode: event.target.value as ApprovalMode })
            }
          >
            <option value="ask">需审批</option>
            <option value="auto">自主执行</option>
          </select>
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">允许的能力</legend>
        <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
          {permissionGroups(chief).map((group) => {
            const count = group.tools.filter((tool) => toolNames.includes(tool)).length;
            return (
              <label key={group.id} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={count === group.tools.length}
                  ref={(element) => {
                    if (element) element.indeterminate = count > 0 && count < group.tools.length;
                  }}
                  onChange={(event) =>
                    onPermissionsChange({
                      approvalMode,
                      toolNames: event.target.checked
                        ? [...new Set([...toolNames, ...group.tools])]
                        : toolNames.filter((tool) => !group.tools.includes(tool)),
                    })
                  }
                />
                <span>
                  {group.label}
                  {count > 0 && count < group.tools.length && (
                    <span className="ml-1 text-xs text-slate-500">（部分）</span>
                  )}
                  <span className="block text-xs leading-5 text-slate-500">{group.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <details ref={details} className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">精细设置</summary>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {Object.entries(builtinToolLabels)
            .filter(([name]) => name !== 'read_skill' && (chief || !chiefOnlyTools.includes(name)))
            .map(([name, label]) => {
              const getToolLabel = () => {
                if (chief && name === 'list_processes') {
                  return '查看应用内命令';
                }
                if (chief && name === 'stop_process') {
                  return '停止应用内命令';
                }
                return label;
              };
              return (
                <label
                  key={name}
                  className="flex min-w-0 items-center gap-2 text-xs text-slate-600"
                  title={name}
                >
                  <input
                    type="checkbox"
                    checked={toolNames.includes(name)}
                    onChange={() =>
                      onPermissionsChange({ approvalMode, toolNames: toggle(toolNames, name) })
                    }
                  />
                  <span>{getToolLabel()}</span>
                </label>
              );
            })}
        </div>
      </details>
    </>
  );
}

function ExternalConnections({
  data,
  ids,
  onChange,
}: {
  data: Snapshot;
  ids: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <details className="rounded-lg border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        外部连接授权（{ids.length}）
      </summary>
      <p className="mt-2 text-xs leading-5 text-slate-500">选择成员可使用的搜索和 MCP 连接。</p>
      <div className="mt-3 grid gap-2">
        {data.toolConnections.length ? (
          data.toolConnections.map((item) => (
            <label key={item.id} className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={ids.includes(item.id)}
                onChange={() => onChange(toggle(ids, item.id))}
              />
              <span>{item.name}</span>
              <span className="ml-auto text-xs text-slate-500">
                {item.kind === 'search' ? '搜索' : 'MCP'}
                {!item.enabled && ' · 未启用'}
              </span>
            </label>
          ))
        ) : (
          <p className="text-xs leading-5 text-slate-500">
            在连接与设置中添加外部工具，再为成员授权。
          </p>
        )}
      </div>
    </details>
  );
}

function QoderServices({
  values,
  onChange,
}: {
  values: QoderService[];
  onChange: (values: QoderService[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-slate-700">Qoder 原生服务</legend>
      <p className="mb-3 text-xs leading-5 text-slate-500">单独授权此成员使用 Qoder 提供的服务。</p>
      <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
        {serviceOptions.map((service) => (
          <label key={service.id} className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-1"
              checked={values.includes(service.id)}
              onChange={() =>
                onChange(
                  values.includes(service.id)
                    ? values.filter((value) => value !== service.id)
                    : [...values, service.id],
                )
              }
            />
            <span>
              {service.label}
              <span className="block text-xs leading-5 text-slate-500">{service.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function BotTools({
  data,
  toolConnectionIds,
  onConnectionsChange,
  qoderServices,
  onQoderServicesChange,
  chief = false,
  ...permissions
}: {
  data: Snapshot;
  toolConnectionIds: string[];
  onConnectionsChange: (values: string[]) => void;
  qoderServices?: QoderService[];
  onQoderServicesChange?: (values: QoderService[]) => void;
  chief?: boolean;
} & Omit<ToolPermissionsProps, 'chief'>) {
  return (
    <div className="grid gap-4">
      <PermissionControls {...permissions} chief={chief} />
      {onQoderServicesChange && (
        <QoderServices
          values={enabledQoderServices({ qoderServices, toolNames: permissions.toolNames })}
          onChange={onQoderServicesChange}
        />
      )}
      <ExternalConnections data={data} ids={toolConnectionIds} onChange={onConnectionsChange} />
    </div>
  );
}
