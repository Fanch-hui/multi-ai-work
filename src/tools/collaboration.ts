import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';
export function createCollaborationTools() {
  return {
    request_collaboration: {
      description:
        '向当前团队群的另一成员提出明确协作请求，由主管确认、派发并将结果回传。不要重复提出已有请求。',
      schema: z.object({
        targetBotId: z.string(),
        goal: z.string().min(1).max(20000),
        expectedOutput: z.string().max(20000).optional(),
        artifactIds: z.array(z.string()).max(10).optional(),
      }),
      available: (context: ToolExecutionContext) => !!context.requestCollaboration,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.requestCollaboration!(args, context),
    },
    resolve_collaboration: {
      description: '主管处理当前团队群的成员协作请求；接受后创建真实成员任务，结果自动回到请求者。',
      schema: z.object({
        id: z.string(),
        action: z.enum(['accept', 'decline']),
        feedback: z.string().max(20000).optional(),
      }),
      available: (context: ToolExecutionContext) => !!context.resolveCollaboration,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.resolveCollaboration!(args, context),
    },
  };
}
