import { z } from 'zod';
import { routineInputSchema } from '../domain/routine-input.js';
import type { ToolExecutionContext } from '../domain/tools.js';

export function createOngoingWorkTools() {
  return {
    manage_routines: {
      description:
        '根据用户明确要求创建或管理例行工作。支持list/get/save/setEnabled/runNow/history；保存显示时区及下次执行，自动触发在独立会话中进行。',
      schema: z.object({
        action: z.enum(['list', 'get', 'save', 'setEnabled', 'runNow', 'history']),
        id: z.string().optional(),
        enabled: z.boolean().optional(),
        input: routineInputSchema.optional(),
      }),
      available: (context: ToolExecutionContext) => !!context.manageRoutines,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.manageRoutines!(args, context),
    },
    record_artifact_review: {
      description:
        '对本任务明确提供的成果登记复核结论。结论绑定具体文件及需求版本；列明需修改问题及证据。AI通过与用户接受分别保存。',
      schema: z.object({
        artifactIds: z.array(z.string()).min(1).max(10),
        outcome: z.enum(['passed', 'changes_requested']),
        feedback: z.string().max(20000),
      }),
      available: (context: ToolExecutionContext) => !!context.recordArtifactReview,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext) =>
        context.recordArtifactReview!(args, context),
    },
  };
}
