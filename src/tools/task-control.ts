import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

const target = { taskId: z.string().min(1).optional(), runId: z.string().min(1).optional() };
export function createTaskControlTools() {
  return {
    stop_task: {
      description: '停止当前会话或显式来源任务群中的成员模型任务及其命令。填写 taskId 或当前 runId，按执行权限确认；返回实际停止状态与是否需要核查。',
      schema: z.object(target).strict(), available: (context: ToolExecutionContext) => !!context.stopTask,
      execute: (args: { taskId?: string; runId?: string }, context: ToolExecutionContext) => context.stopTask!(args),
    },
    send_task_input: {
      description: '把明确的新要求或文件接入当前执行的成员任务，artifactIds 填写需要补发的获准文件 ID，复用该任务与会话。需求变更应使用此工具，保留工具结果；不另派依赖旧任务的变更任务。使用 get_task 查看实际接收状态。',
      schema: z.object({ ...target, content: z.string().trim().min(1).max(100000), artifactIds: z.array(z.string()).max(50).optional() }).strict(),
      available: (context: ToolExecutionContext) => !!context.sendTaskInput,
      execute: (args: { taskId?: string; runId?: string; content: string; artifactIds?: string[] }, context: ToolExecutionContext) => context.sendTaskInput!(args),
    },
    reconcile_task: {
      description: '确认已停止任务的未知操作结果，解除对账等待。必须先查实际目标文件、外部状态或操作收据，再选择 succeeded 或 not_executed；不得根据模型终态猜测。',
      schema: z.object({ ...target, outcome: z.enum(['succeeded', 'not_executed']) }).strict(),
      available: (context: ToolExecutionContext) => !!context.reconcileTask,
      execute: (args: { taskId?: string; runId?: string; outcome: 'succeeded' | 'not_executed' }, context: ToolExecutionContext) => context.reconcileTask!(args),
    },
  };
}
