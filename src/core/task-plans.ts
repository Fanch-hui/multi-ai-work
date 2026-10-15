import type { Bot, Conversation, Task } from '../domain/types.js';
import { planStepUpdateSchema, taskPlanSchema, type PlanStepInput, type PlanStepUpdate,
  type TaskPlanInput, type TaskPlanRecord } from '../domain/task-plan.js';
import { terminal } from '../domain/task-status.js';
import { required } from './errors.js';
import { State, now } from './state.js';
import { taskPlanRoot, taskPlanView } from './task-plan-view.js';

export class TaskPlanService {
  constructor(private state: State) {}

  private root(task: Task, writing = false) {
    const s = this.state.storage, current = required(s.get<Task>('tasks', task.id), '任务不存在');
    const room = required(s.get<Conversation>('conversations', current.conversationId), '会话不存在');
    if (current.kind || current.botId !== this.state.settings().mainBotId || room.chiefId !== current.botId)
      throw new Error('只有管家可以管理任务安排');
    const root = required(taskPlanRoot(s, current), '任务来源关系已失效');
    if (writing && (room.archived || terminal(current.status) || terminal(root.status))) throw new Error('任务已结束或会话已归档');
    return root;
  }

  get(task: Task) {
    const plan = this.state.storage.get<TaskPlanRecord>('task_plans', this.root(task).id);
    return plan && this.view(plan);
  }

  set(task: Task, input: TaskPlanInput) {
    const root = this.root(task, true), fields = taskPlanSchema.parse(input), s = this.state.storage;
    const old = s.get<TaskPlanRecord>('task_plans', root.id);
    const tasks = s.all<Task>('tasks').filter(item => item.planId === root.id);
    const steps = fields.steps.map(step => ({ ...step, memberIds: [...new Set(step.memberIds)], dependencyIds: [...new Set(step.dependencyIds)] }));
    const seen = new Set<string>();
    for (const step of steps) {
      if (seen.has(step.id)) throw new Error('步骤 ID 不能重复');
      if (step.dependencyIds.some(dependency => !seen.has(dependency))) throw new Error('前置步骤必须在当前步骤之前');
      seen.add(step.id);
      for (const memberId of step.memberIds) {
        const bot = required(s.get<Bot>('bots', memberId), '安排中的成员不存在');
        if (bot.archived) throw new Error('安排中的成员已归档');
      }
      if (step.kind === 'discussion' && step.memberIds.every(memberId => memberId === root.botId))
        throw new Error('讨论步骤需要团队成员参与');
    }
    for (const previous of old?.steps ?? []) {
      const started = tasks.some(item => item.planStepId === previous.id) || previous.chiefStatus && previous.chiefStatus !== 'pending';
      const next = steps.find(step => step.id === previous.id);
      if (started && (!next || this.assignment(previous) !== this.assignment(next)))
        throw new Error('已开始的步骤须保留参与成员和依赖，可调整后续步骤');
    }
    const plan: TaskPlanRecord = { id: root.id, taskId: root.id, conversationId: root.conversationId, title: fields.title,
      steps: steps.map(step => ({ ...step, chiefStatus: old?.steps.find(item => item.id === step.id)?.chiefStatus,
        note: old?.steps.find(item => item.id === step.id)?.note })), createdAt: old?.createdAt ?? now(), updatedAt: now() };
    s.put('task_plans', plan); this.state.changed(); return this.view(plan);
  }

  update(task: Task, input: PlanStepUpdate) {
    const root = this.root(task, true), fields = planStepUpdateSchema.parse(input), s = this.state.storage;
    const plan = required(s.get<TaskPlanRecord>('task_plans', root.id), '请先建立任务安排');
    const step = required(plan.steps.find(item => item.id === fields.stepId), '安排步骤不存在');
    const linked = s.all<Task>('tasks').filter(item => item.planId === plan.id && item.planStepId === step.id);
    if (step.chiefStatus === 'completed' && fields.status && fields.status !== 'completed') throw new Error('管家已完成的工作不能重新标记为进行中');
    if (fields.status === 'skipped' && (linked.length || step.chiefStatus === 'completed')) throw new Error('已执行的步骤不能跳过');
    if (fields.status && fields.status !== 'skipped') {
      if (step.kind !== 'work' || !step.memberIds.includes(root.botId)) throw new Error('成员步骤进度由实际任务更新');
      this.requireDependencies(plan, step);
    }
    const updated = { ...plan, updatedAt: now(), steps: plan.steps.map(item => item.id === step.id
      ? { ...item, ...(fields.status ? { chiefStatus: fields.status } : {}), ...(fields.note !== undefined ? { note: fields.note } : {}) } : item) };
    s.put('task_plans', updated); this.state.changed(); return this.view(updated);
  }

  delegation(parent: Task, room: Conversation, botId: string, stepId: string) {
    const root = this.root(parent, true), s = this.state.storage;
    const plan = required(s.get<TaskPlanRecord>('task_plans', root.id), '请先建立任务安排');
    const step = required(plan.steps.find(item => item.id === stepId), '安排步骤不存在');
    if (!step.memberIds.includes(botId) || botId === root.botId) throw new Error('被委派成员不属于此步骤');
    if (step.chiefStatus === 'skipped') throw new Error('步骤已跳过');
    const view = this.view(plan), dependencies: string[] = [];
    for (const dependencyId of step.dependencyIds) {
      const previous = required(view.steps.find(item => item.id === dependencyId), '前置步骤不存在');
      if (previous.status === 'completed' || previous.status === 'skipped') continue;
      const tasks = previous.taskIds.map(taskId => required(s.get<Task>('tasks', taskId), '前置任务不存在'));
      if (previous.memberIds.includes(root.botId) && previous.kind === 'work'
          && plan.steps.find(item => item.id === previous.id)?.chiefStatus !== 'completed'
        || previous.memberIds.filter(memberId => memberId !== root.botId).some(memberId => !tasks.some(item => item.botId === memberId))
        || !tasks.length || tasks.some(item => item.parentId !== parent.id || item.conversationId !== room.id))
        throw new Error('请先完成管家前置工作，并完整派发前置步骤的成员任务');
      dependencies.push(...tasks.map(item => item.id));
    }
    return { planId: plan.id, planStepId: step.id, dependencyIds: dependencies };
  }

  private requireDependencies(plan: TaskPlanRecord, step: PlanStepInput) {
    const view = this.view(plan);
    if (step.dependencyIds.some(dependencyId => !['completed', 'skipped'].includes(view.steps.find(item => item.id === dependencyId)!.status)))
      throw new Error('请先完成前置步骤');
  }
  private assignment(step: PlanStepInput) {
    return JSON.stringify({ kind: step.kind, members: [...step.memberIds].sort(), dependencies: [...step.dependencyIds].sort() });
  }
  private view(plan: TaskPlanRecord) {
    return taskPlanView(plan, this.state.storage.all<Task>('tasks'), this.state.settings().mainBotId!);
  }
}
