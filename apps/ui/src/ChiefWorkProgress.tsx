import { ChevronRight, ListOrdered } from 'lucide-react';
import type { Snapshot } from '../../../src/domain/types.js';
import { activeTask, Button } from './components.js';
import { TaskPlanCard } from './TaskPlanCard.js';
import { taskRecordStatus } from './conversation-records.js';

export function ChiefWorkProgress({
  data,
  onRecords,
  onSelectConversation,
}: {
  data: Snapshot;
  onRecords: () => void;
  onSelectConversation: (id: string) => void;
}) {
  const work =
    data.chief?.contexts.flatMap((context) => {
      if (context.kind !== 'work') return [];
      const tasks = data.tasks.filter(
        (task) =>
          !task.kind &&
          context.conversationIds.includes(task.conversationId) &&
          activeTask(task.status),
      );
      return tasks.length ? [{ context, tasks }] : [];
    }) ?? [];
  if (!work.length) return null;
  return (
    <details className="group min-w-0 rounded-xl border border-slate-200 bg-white">
      <summary
        className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1 text-xs [&::-webkit-details-marker]:hidden"
        aria-label="后台工作进度"
      >
        <ListOrdered size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-slate-600">
          {work.map((item) => item.context.title).join(' · ')}
        </span>
        <span className="shrink-0 text-slate-400">{work.length} 项进行中</span>
        <ChevronRight
          size={13}
          className="shrink-0 text-slate-400 group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="grid max-h-64 gap-3 overflow-auto border-t border-slate-100 px-3 py-3">
        {work.map(({ context, tasks }) => {
          const taskIds = new Set(tasks.map((task) => task.id));
          const plan = data.taskPlans.filter((item) => taskIds.has(item.taskId)).at(-1);
          const project = data.workspaces.find((item) => item.id === context.workspaceId);
          return (
            <div key={context.id} className="grid min-w-0 gap-2">
              <p className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
                <span className="min-w-0 flex-1 truncate">{context.title}</span>
                {project && <span className="truncate text-slate-400">{project.name}</span>}
                <span className="shrink-0">{taskRecordStatus(tasks[0], data.processes ?? [])}</span>
              </p>
              {plan && (
                <TaskPlanCard plan={plan} data={data} onSelectConversation={onSelectConversation} />
              )}
            </div>
          );
        })}
        <Button variant="ghost" className="justify-self-end text-xs" onClick={onRecords}>
          查看记录
        </Button>
      </div>
    </details>
  );
}
