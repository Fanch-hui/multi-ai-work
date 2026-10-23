import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

export function createWorkSkillTools() {
  return {
    save_work_skill: {
      description:
        '用户要求保存工作流程时，将当前任务中已经明确的步骤整理为可审阅技能草稿。写明适用场景、输入、操作、交付与验收；去掉单次任务资料。用户在技能面板审阅保存后才生效。',
      schema: z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000),
        content: z.string().min(1).max(120000),
        sourceTaskId: z.string().optional(),
      }),
      available: (context: ToolExecutionContext) => !!context.saveWorkSkill,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.saveWorkSkill!(args, context),
    },
  };
}
