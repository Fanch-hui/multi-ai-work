import type { ProcessRecord, Run, RunEvent, Task } from '../../../src/domain/types.js';
import { cn } from './classNames.js';
import { chatActivityLabel } from './chat-status.js';

export function agentActivity(
  task?: Task,
  run?: Run,
  events: RunEvent[] = [],
  streaming = false,
  processes: ProcessRecord[] = [],
): string {
  return chatActivityLabel(task, run, events, streaming, processes);
}

export function AgentActivity({
  label,
  animated = true,
  className,
}: {
  label: string;
  animated?: boolean;
  className?: string;
}) {
  return (
    <span
      role="status"
      className={cn(
        'agent-activity inline-flex items-center gap-2 text-xs text-slate-400',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn('agent-activity-indicator', animated && 'agent-activity-animated')}
      >
        <i />
        <i />
        <i />
      </span>
      <span key={label} className="agent-activity-label">
        {label}
      </span>
    </span>
  );
}
