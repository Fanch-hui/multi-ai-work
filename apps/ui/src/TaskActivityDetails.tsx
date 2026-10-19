import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Run, Task } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { Button, ErrorNote, activeTask } from './components.js';
import {
  activityStalled,
  currentActivityLabel,
  recoveryWaitLabel,
  taskRecovery,
} from './task-activity.js';

export function TaskActivityDetails({
  task,
  run,
  mutate,
}: {
  task: Task;
  run?: Run;
  mutate: Mutate;
}) {
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const active = activeTask(task.status);
  const recovery = taskRecovery(task);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), recovery ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [active, recovery?.nextAttemptAt]);
  async function inspect() {
    setBusy(true);
    setError('');
    try {
      await mutate('tasks.inspect', { id: task.id });
      setNow(Date.now());
      setChecked(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="任务活动"
      className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-700">
          {currentActivityLabel(task, run) ?? '尚无活动记录'}
        </p>
        {active && (
          <Button
            variant="ghost"
            disabled={busy}
            className="min-h-8 px-2 text-xs"
            onClick={() => void inspect()}
          >
            <RefreshCw size={13} />
            {busy ? '检查中…' : '检查状态'}
          </Button>
        )}
      </div>
      {recovery && (
        <p role="status" className="mt-2 text-slate-500">
          {recoveryWaitLabel(task, now)}
        </p>
      )}
      {activityStalled(task, now) && (
        <p role="status" className="mt-2 text-amber-700">
          较长时间未收到活动
        </p>
      )}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        {recovery && <ActivityTime label="下次尝试" value={recovery.nextAttemptAt} />}
        <ActivityTime label="最后模型活动" value={task.activity?.lastModelActivityAt} />
        <ActivityTime label="最后工具活动" value={task.activity?.lastToolActivityAt} />
        {task.activity?.toolName && (
          <>
            <dt className="text-slate-400">
              {task.activity.phase === 'tool' ? '当前工具' : '最近工具'}
            </dt>
            <dd className="min-w-0 truncate">{task.activity.toolName}</dd>
          </>
        )}
        {task.activity?.waitingFor && (
          <>
            <dt className="text-slate-400">等待对象</dt>
            <dd className="min-w-0 break-words">{task.activity.waitingFor}</dd>
          </>
        )}
        {task.activity?.checkpointId && (
          <>
            <dt className="text-slate-400">检查点</dt>
            <dd className="min-w-0 truncate" title={task.activity.checkpointId}>
              {task.activity.checkpointId}
            </dd>
          </>
        )}
      </dl>
      {checked && (
        <p role="status" className="mt-2 text-slate-400">
          状态已刷新
        </p>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

function ActivityTime({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <dt className="text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words tabular-nums">
        {value ? (
          <time dateTime={value} title={value}>
            {new Date(value).toLocaleString(undefined, { hour12: false })}
          </time>
        ) : (
          '暂无记录'
        )}
      </dd>
    </>
  );
}
