import { z } from 'zod';
import { stat } from 'node:fs/promises';
import type { CommandInput, ToolExecutionContext } from '../domain/tools.js';
import { workspacePath } from './paths.js';
import { startCommand } from './process-runner.js';

export async function commandDirectory(input: CommandInput, context: ToolExecutionContext, approved = false) {
  if (!context.workspace.writable) throw new Error('工作目录仅允许读取');
  const cwd = await workspacePath(input.workdir ?? '.', context);
  if (!(await stat(cwd)).isDirectory()) throw new Error('命令工作路径必须是目录');
  if (!approved && !await context.requestApproval('run_command', `执行：${input.command} ${input.args.join(' ')}`, { ...input, workdir: cwd })) {
    throw new Error('脚本执行未获批准');
  }
  context.signal.throwIfAborted();
  return workspacePath(input.workdir ?? '.', context);
}

export async function runCommand(command: string, args: string[], context: ToolExecutionContext, options: Omit<CommandInput, 'command' | 'args'> = {}): Promise<unknown> {
  const input = { command, args, ...options };
  if (context.processes) return context.processes.run(input);
  if (input.background) throw new Error('后台命令管理不可用');
  const cwd = await commandDirectory(input, context);
  context.markDispatched?.();
  let stdout = '', stderr = '';
  const active = startCommand(input, cwd, (stream, text) => {
    if (stream === 'stdout') stdout = (stdout + text).slice(-60_000);
    else stderr = (stderr + text).slice(-30_000);
  }, context.signal);
  const outcome = await active.done;
  context.signal.throwIfAborted();
  if (outcome.error) throw outcome.error;
  return { code: outcome.code, signal: outcome.signal, stdout, stderr, timedOut: outcome.status === 'timed_out' };
}

const processId = z.string().min(1).max(200);
export function createProcessTools() {
  return {
    run_command: {
      description: '在授权工作目录执行命令，按成员执行权限确认操作。默认同步等待 60 秒；background 返回 processId，默认限时 10 分钟，最长 30 分钟。',
      schema: z.object({ command: z.string().min(1).max(2000), args: z.array(z.string().max(8000)).max(100),
        background: z.boolean().optional(), workdir: z.string().max(8000).optional(), timeoutMs: z.number().int().min(1).max(1_800_000).optional() }),
      available: (context: ToolExecutionContext) => context.workspace.writable,
      execute: (args: CommandInput, context: ToolExecutionContext) => runCommand(args.command, args.args, context, args),
    },
    list_processes: {
      description: '列出本任务创建的命令及实际运行状态；内置主管可查看应用管理的全部命令记录。', schema: z.object({}),
      available: (context: ToolExecutionContext) => !!context.processes,
      execute: (_args: unknown, context: ToolExecutionContext) => context.processes!.list(),
    },
    read_process: {
      description: '按字符游标读取本任务命令的有界日志，返回 nextOffset、是否截断及实际退出状态。',
      schema: z.object({ processId, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(60_000).optional(),
        waitMs: z.number().int().min(0).max(10_000).optional() }),
      available: (context: ToolExecutionContext) => !!context.processes,
      execute: (args: { processId: string; offset?: number; limit?: number; waitMs?: number }, context: ToolExecutionContext) => context.processes!.read(args),
    },
    stop_process: {
      description: '成员只能停止本任务由自己创建的命令；内置主管可停止应用管理的任何成员命令。仅接受 processId，等待命令及子进程实际退出后返回。', schema: z.object({ processId }),
      available: (context: ToolExecutionContext) => !!context.processes,
      execute: (args: { processId: string }, context: ToolExecutionContext) => context.processes!.stop(args.processId),
    },
  };
}
