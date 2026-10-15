import { ArrowUpRight, ChevronRight, ListOrdered } from 'lucide-react';
import type { Snapshot } from '../../../src/domain/types.js';
import type { PlanStep, TaskPlan } from '../../../src/domain/task-plan.js';
import { Avatar } from './Avatar.js';
import { Badge, cn } from './components.js';
import { planCurrentSteps, planDependencies, planProgress, planStepStatus } from './task-plans.js';

export function TaskPlanCard({ plan, data, onSelectConversation }: {
  plan: TaskPlan; data: Snapshot; onSelectConversation?: (id: string) => void;
}) {
  return <details className="group min-w-0 rounded-xl border border-slate-200 bg-white">
    <summary title={plan.title} aria-label={`任务安排：${plan.title}，${planCurrentSteps(plan)}，${planProgress(plan)}`}
      className="flex min-h-8 min-w-0 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
      <ListOrdered aria-hidden="true" size={13} className="shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1 truncate text-slate-600">{planCurrentSteps(plan)}</span>
      <span className="shrink-0 tabular-nums text-slate-400">{planProgress(plan)}</span>
      <ChevronRight aria-hidden="true" size={13} className="shrink-0 text-slate-400 group-open:rotate-90" />
    </summary>
    <div className="task-plan-steps grid min-w-0 gap-3 border-t border-slate-100 px-3 py-3">
      <h3 className="truncate text-sm font-medium text-slate-800">{plan.title}</h3>
      <ol className="grid min-w-0 gap-3" aria-label="任务执行步骤">
      {plan.steps.map((step, index) => <PlanStepRow key={step.id} step={step} index={index} plan={plan}
        data={data} onSelectConversation={onSelectConversation} />)}
      </ol>
    </div>
  </details>;
}

function PlanStepRow({ step, index, plan, data, onSelectConversation }: {
  step: PlanStep; index: number; plan: TaskPlan; data: Snapshot; onSelectConversation?: (id: string) => void;
}) {
  const dependencies = planDependencies(plan, step);
  const rooms = data.conversations.filter(room => step.conversationIds.includes(room.id));
  return <li className="flex min-w-0 items-start gap-3">
    <span className={cn('mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums',
      step.status === 'running' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500')}>{index + 1}</span>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="min-w-0 break-words text-pretty text-sm font-medium text-slate-800">{step.title}</h3>
        <Badge status={step.status}>{planStepStatus(step, data)}</Badge>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-slate-400">{step.kind === 'discussion' ? '共同讨论' : step.memberIds.length > 1 ? '并行执行' : '执行'}</span>
        {step.memberIds.map(id => {
          const bot = data.bots.find(item => item.id === id);
          return <span key={id} className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs text-slate-600">
            <Avatar bot={bot} name={bot?.name ?? '已移除成员'} className="size-5 rounded-md" />
            <span className="truncate">{bot?.name ?? '已移除成员'}</span>
          </span>;
        })}
      </div>
      {dependencies && <p className="mt-2 break-words text-pretty text-xs text-slate-500">前置：{dependencies}</p>}
      {step.description && <p className="mt-2 break-words text-pretty text-xs leading-5 text-slate-500">{step.description}</p>}
      {step.note && <p className="mt-2 break-words text-pretty text-xs leading-5 text-slate-600">{step.note}</p>}
      {!!rooms.length && <div className="mt-2 flex min-w-0 flex-wrap gap-2">
        {rooms.map(room => onSelectConversation ? <button key={room.id} onClick={() => onSelectConversation(room.id)}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500">
          <span className="truncate">{room.name}</span><ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
        </button> : <span key={room.id} className="truncate text-xs text-slate-400">{room.name}</span>)}
      </div>}
    </div>
  </li>;
}
