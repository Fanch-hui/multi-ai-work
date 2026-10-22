import type { Snapshot, Task } from '../../../src/domain/types.js';
import { processRecordStatus } from './conversation-records.js';
import { taskWorkOverview } from './task-work-overview.js';

export function TaskWorkOverview({
  task,
  data,
  compact = false,
}: {
  task: Task;
  data: Snapshot;
  compact?: boolean;
}) {
  const work = taskWorkOverview(data, task);
  const processes = compact
    ? work.processes.filter((item) => ['running', 'unknown'].includes(item.status))
    : work.processes;
  return (
    <div aria-label="工作概览" className="mt-3 grid min-w-0 gap-2 text-xs leading-5 text-slate-600">
      <p>当前阶段：{work.stage}</p>
      {work.currentStep && <p className="break-words">当前步骤：{work.currentStep}</p>}
      {!!work.operations.length && (
        <p className="break-words">
          正在处理：{work.operations.join(' · ')}
          {work.operationCount > work.operations.length &&
            ` · 另有 ${work.operationCount - work.operations.length} 项操作`}
        </p>
      )}
      {(work.progress || !!work.deliverables) && (
        <p className="tabular-nums">
          {work.progress && `已完成：${work.progress}`}
          {work.progress && !!work.deliverables && ' · '}
          {!!work.deliverables && `已生成 ${work.deliverables} 份成果`}
        </p>
      )}
      {work.note && <p className="break-words">进展备注：{work.note}</p>}
      {work.waiting.map((item) => (
        <p key={item} className="break-words text-amber-800">
          等待事项：{item}
        </p>
      ))}
      {!!processes.length && (
        <ul className="grid gap-1" aria-label="后台命令状态">
          {processes.map((item) => (
            <li
              key={item.id}
              className={
                ['failed', 'timed_out', 'unknown'].includes(item.status) ? 'text-amber-800' : ''
              }
            >
              后台命令 · {item.command.split(/[\\/]/).at(-1)} · {processRecordStatus(item)}
              {item.code != null && ` · 退出码 ${item.code}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
