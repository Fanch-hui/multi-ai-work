import { z } from 'zod';
import {
  taskPlanSchema,
  planStepUpdateSchema,
  type TaskPlanInput,
  type PlanStepUpdate,
} from '../domain/task-plan.js';
import type { ToolExecutionContext } from '../domain/tools.js';

export function createTaskPlanTools() {
  return {
    set_task_plan: {
      description:
        '为当前任务建立或调整团队工作安排，不启动执行。使用稳定步骤 ID，填写可共享的工作内容、实际 memberIds、work 或 discussion 类型和必须等待的 dependencyIds。多个成员表示并行工作或共同讨论；无依赖的步骤可并行。已委派步骤保留成员和类型；从未执行的排队步骤可调整 dependencyIds，并同步实际任务依赖，显式委派依赖继续生效；执行过的步骤保留依赖。实际成员任务仍由 create_task_group 和 delegate_task 执行。',
      schema: taskPlanSchema,
      available: (context: ToolExecutionContext) => !!context.setTaskPlan,
      execute: (args: TaskPlanInput, context: ToolExecutionContext) => context.setTaskPlan!(args),
    },
    get_task_plan: {
      description:
        '读取当前任务的同一份团队安排及实际进度，主对话和来源绑定的任务群共享。成员步骤由 Core 根据实际任务投影状态，未派发成员保持未完成。',
      schema: z.object({}),
      available: (context: ToolExecutionContext) => !!context.getTaskPlan,
      execute: (_args: unknown, context: ToolExecutionContext) => context.getTaskPlan!() ?? null,
    },
    update_plan_step: {
      description:
        '记录安排进展。status 只更新 work 步骤中管家自己的工作，成员及讨论进度由实际任务更新；note 可记录简短进展或调整理由。尚未执行的步骤可标记 skipped。管家工作开始或完成前必须满足前置步骤。',
      schema: planStepUpdateSchema,
      available: (context: ToolExecutionContext) => !!context.updatePlanStep,
      execute: (args: PlanStepUpdate, context: ToolExecutionContext) =>
        context.updatePlanStep!(args),
    },
  };
}
