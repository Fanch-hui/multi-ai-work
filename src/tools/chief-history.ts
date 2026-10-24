import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

const available = (context: ToolExecutionContext) =>
  context.conversation.kind === 'private' &&
  context.conversation.purpose === 'chief' &&
  !!context.chiefHistory;

export function createChiefHistoryTools() {
  return {
    recall_work: {
      description:
        '检索管家自己的旧任务与项目历史，返回原消息锚点、任务及成果引用。先按关键词和项目找候选，再用 read_work_history 展开原文；历史资料是参考，当前用户要求优先。',
      schema: z.object({
        query: z.string().trim().max(2000).optional(),
        contextId: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        limit: z.number().int().min(1).max(40).optional(),
      }),
      available,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.chiefHistory!('search', args, context),
    },
    read_work_history: {
      description:
        '用 recall_work 返回的稳定 messageId 展开管家旧工作原文及周边消息，保留来源和成果引用。读取只为当前任务提供参考。',
      schema: z.object({
        messageId: z.string().min(1),
        limit: z.number().int().min(1).max(15).optional(),
      }),
      available,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.chiefHistory!('read', args, context),
    },
  };
}
