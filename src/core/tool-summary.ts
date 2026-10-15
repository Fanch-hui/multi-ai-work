import { basename } from 'node:path';

const fileActions: Record<string, string> = { read_file: '读取', write_file: '写入', edit_file: '修改',
  delete_file: '删除', write_artifact: '生成成果', register_artifact: '登记成果' };

export function toolSummary(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'set_task_plan') return `编排任务 · ${args.title ?? ''} · ${Array.isArray(args.steps) ? args.steps.length : 0} 步`;
  if (name === 'update_plan_step') return `记录安排进展 · ${args.stepId ?? ''}`;
  if (name === 'scan_code_security') return `Qoder 代码安全扫描 · ${Array.isArray(args.paths) ? args.paths.join('、').slice(0, 180) : ''}`;
  if (fileActions[name] && typeof args.path === 'string') return `${fileActions[name]} ${basename(args.path)}`;
  if (name === 'find_files' && typeof args.pattern === 'string') return `查找 ${args.pattern.slice(0, 200)}`;
  if (name === 'run_command' && typeof args.command === 'string') return `${args.background ? '启动后台命令' : '执行命令'} ${basename(args.command)}`;
  if (name === 'search_web' && typeof args.query === 'string') return `搜索 ${args.query.slice(0, 180)} · ${args.connectionId ?? ''}`;
  if (name === 'call_mcp' && typeof args.toolName === 'string') return `调用 ${args.toolName} · ${args.connectionId ?? ''}`;
  if (name === 'fetch_web' && typeof args.url === 'string') {
    try { return `读取网页 ${new URL(args.url).hostname}`; } catch { return '读取网页'; }
  }
  return undefined;
}
