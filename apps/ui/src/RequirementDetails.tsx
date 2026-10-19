import type { Artifact, Task } from '../../../src/domain/types.js';
import { ChevronRight } from 'lucide-react';
import { timeLabel } from './components.js';
import { cn } from './classNames.js';

export function RequirementDetails({ task }: { task: Task }) {
  const requirement = task.requirement;
  if (!requirement) return null;
  return (
    <details className="group min-w-0 rounded-xl border border-slate-200 bg-white text-xs text-slate-600">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          需求版本 <span className="tabular-nums">v{requirement.version}</span>
        </span>
        <ChevronRight
          size={15}
          aria-hidden="true"
          className="shrink-0 text-slate-400 group-open:rotate-90"
        />
      </summary>
      <ol className="grid list-none gap-3 border-t border-slate-100 p-3">
        <li>
          <p className="tabular-nums text-slate-400">v1 · 初始要求</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-pretty leading-5">{task.goal}</p>
          {task.expectedOutput && (
            <p className="mt-1 whitespace-pre-wrap break-words text-pretty leading-5">
              预期成果：{task.expectedOutput}
            </p>
          )}
        </li>
        {requirement.updates.map((update) => (
          <li key={update.messageId}>
            <p className="tabular-nums text-slate-400">
              v{update.version} · {timeLabel(update.createdAt)}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-pretty leading-5">
              {update.content}
            </p>
            {!!update.artifactIds.length && (
              <p className="mt-1 text-slate-400">
                附带资料 <span className="tabular-nums">{update.artifactIds.length}</span> 项
              </p>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function ArtifactRequirement({
  artifact,
  className,
}: {
  artifact: Artifact;
  className?: string;
}) {
  if (!artifact.requirementVersion && !artifact.superseded) return null;
  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-1.5 text-xs text-slate-400', className)}
    >
      {artifact.requirementVersion && (
        <span className="tabular-nums">需求 v{artifact.requirementVersion}</span>
      )}
      {artifact.superseded && (
        <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500">
          已替代
        </span>
      )}
    </span>
  );
}
