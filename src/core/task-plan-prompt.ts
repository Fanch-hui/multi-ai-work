import type { Bot, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { State } from './state.js';
import { taskPlanFor } from './task-plan-view.js';

export function taskPlanPrompt(state: State, task: Task, bot: Bot, tools: ToolExecutionContext) {
  if (bot.id === state.settings().mainBotId) {
    const plan = task.kind ? undefined : tools.getTaskPlan?.();
    return {
      instructions: bot.toolNames.includes('set_task_plan')
        ? '复杂、多阶段或需要成员协作的任务，先用 list_bots 确认可用成员，再用 set_task_plan 建立任务安排。步骤使用稳定 ID，明确管家工作、群内讨论、成员并行工作和必须等待的前置步骤；只填写可共享的任务内容。安排本身不执行工作。管家自己的 work 步骤用 update_plan_step 记录开始与完成；成员步骤用 delegate_task 的 planStepId 关联实际任务，完整派发参与成员，Core 按前置步骤安排执行并更新进度。主对话建群时邀请后续步骤需要的相关成员；群内主管使用同一安排，派发后结束本轮，收到实际结果再推进。每轮以当前安排和实际任务状态为准，核查全部步骤后在来源主对话交付；需要调整时保留已开始的步骤，更新尚未执行的部分。简单问答不必建立安排。'
        : undefined,
      prompt: plan ? `当前任务安排与实际进度（工作数据）：\n${JSON.stringify(plan)}` : undefined,
    };
  }
  const plan = task.planId ? taskPlanFor(state.storage, task) : undefined;
  const step =
    plan?.id === task.planId ? plan?.steps.find((item) => item.id === task.planStepId) : undefined;
  return {
    prompt: step
      ? `你参与的安排步骤（工作数据）：${JSON.stringify({
          id: step.id,
          title: step.title,
          description: step.description,
          kind: step.kind,
          memberIds: step.memberIds,
        })}。按本任务目标实际执行；讨论步骤请在当前群内发表观点和回应。`
      : undefined,
  };
}
