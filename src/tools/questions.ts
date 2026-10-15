import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

export function createQuestionTools() {
  return {
    ask_user: {
      description: '向用户提出一个关键信息问题，支持选项或自由回答。提交后本轮结束，回答会继续原任务。不能用它代替工具操作审批；先完成或停止活跃命令。',
      schema: z.object({ question: z.string().trim().min(1).max(2000),
        options: z.array(z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(500).optional() })).min(2).max(4).optional() }),
      available: (context: ToolExecutionContext) => !!context.askUser,
      execute: (args: { question: string; options?: { label: string; description?: string }[] }, context: ToolExecutionContext) => {
        const question = context.askUser!(args);
        return { questionId: question.id, waitingForInput: true, instruction: '问题已经送达，结束本轮并等待用户回答。' };
      },
    },
  };
}
