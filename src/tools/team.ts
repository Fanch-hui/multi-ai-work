import { z } from 'zod';
import type { TaskGroupInput, ToolExecutionContext } from '../domain/tools.js';
import type { ChiefWorkInput } from '../domain/chief-work.js';

export function createTeamTools() {
  return {
    start_work: {
      description:
        '启动或续做一项独立后台工作，管家主对话保持可用。传入目标、交付要求及明确授权的资料；未提项目时使用工作成果，续做传入 workId 并沿用原项目。指定项目不明确时先向用户自然询问。',
      schema: z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          goal: z.string().trim().min(1).max(120000),
          expectedOutput: z.string().max(120000).optional(),
          workspaceId: z.string().optional(),
          project: z.string().trim().min(1).max(120).optional(),
          artifactIds: z.array(z.string()).max(50).optional(),
          sourceMessageIds: z.array(z.string()).max(30).optional(),
          workId: z.string().optional(),
        })
        .strict(),
      available: (context: ToolExecutionContext) =>
        !!context.startWork && context.conversation.chiefRole === 'main',
      execute: async (args: ChiefWorkInput, context: ToolExecutionContext) => {
        if (
          !(await context.requestApproval(
            'start_work',
            `安排工作：${args.title ?? args.goal.slice(0, 120)}`,
            { ...args },
          ))
        )
          throw new Error('工作安排未获批准');
        context.signal.throwIfAborted();
        context.markDispatched?.();
        return context.startWork!(args, context);
      },
    },
    list_work: {
      description:
        '读取管家独立工作的真实任务、项目、进展和成果引用，可据此补充、续做或停止指定工作。',
      schema: z.object({}),
      available: (context: ToolExecutionContext) =>
        !!context.listWork && context.conversation.chiefRole === 'main',
      execute: (_args: unknown, context: ToolExecutionContext) => context.listWork!(context),
    },
    create_task_group: {
      description:
        '为明确任务创建独立群聊，邀请相关成员与用户参与。仅分享 goal 和交付要求，不复制主对话历史。创建后结束本轮，系统在群任务结束后唤醒主管汇总。相同来源任务和参数复用已建群。',
      schema: z
        .object({
          name: z.string().trim().min(1).max(120),
          goal: z.string().trim().min(1).max(120000),
          memberIds: z.array(z.string().min(1)).min(1).max(50),
          expectedOutput: z.string().max(120000).optional(),
          workspaceId: z.string().optional(),
          artifactIds: z.array(z.string()).max(50).optional(),
        })
        .strict(),
      available: (context: ToolExecutionContext) => !!context.createTaskGroup,
      execute: (args: TaskGroupInput, context: ToolExecutionContext) =>
        context.createTaskGroup!(args),
    },
    list_bots: {
      description: '读取团队成员配置与已添加模型连接目录，不包含其他会话内容或凭据。',
      schema: z.object({}),
      available: (context: ToolExecutionContext) => !!context.listBots,
      execute: (_args: unknown, context: ToolExecutionContext) => context.listBots!(),
    },
    configure_bot: {
      description:
        '创建或调整成员的名称、职责、指令、模型与上下文预算，按成员执行权限确认操作。预设成员使用 personalInstructions 补充要求，预设基础指令由版本管理。现有工具权限保留，新成员采用基础工具；主智能体由用户配置。',
      schema: z
        .object({
          id: z.string().optional(),
          name: z.string().min(1).max(120).optional(),
          role: z.string().max(200).optional(),
          instructions: z.string().max(40000).optional(),
          personalInstructions: z.string().max(20000).optional(),
          connectionId: z.string().optional(),
          model: z.string().optional(),
          reasoning: z.string().max(80).optional(),
          contextWindow: z.number().int().min(1024).optional(),
          compactionThreshold: z.number().int().min(10).max(95).optional(),
        })
        .strict(),
      available: (context: ToolExecutionContext) => !!context.configureBot,
      execute: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
        if (
          !(await context.requestApproval(
            'configure_bot',
            `配置成员：${args.name ?? args.id ?? '新成员'}`,
            args,
          ))
        )
          throw new Error('成员配置未获批准');
        context.signal.throwIfAborted();
        context.markDispatched?.();
        return context.configureBot!(args);
      },
    },
  };
}
