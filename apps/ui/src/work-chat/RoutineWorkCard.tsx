import { useRef, useState } from 'react';
import type { Routine } from '../../../../src/domain/routines.js';
import type { Mutate } from '../store.js';
import { errorMessage } from '../api.js';
import { Button, ErrorNote, timeLabel } from '../components.js';
import { routineScheduleLabel } from '../local-work/Routines.js';

export function RoutineWorkCard({
  routine,
  mutate,
  refresh,
}: {
  routine: Routine;
  mutate: Mutate;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const action = useRef(false);
  const requestId = useRef<string | undefined>(undefined);
  async function execute(runNow = false) {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    setError('');
    try {
      if (runNow) {
        requestId.current ??= crypto.randomUUID();
        await mutate('routines.runNow', { id: routine.id, requestId: requestId.current });
        requestId.current = undefined;
      } else await mutate('routines.setEnabled', { id: routine.id, enabled: !routine.enabled });
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      action.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer text-xs font-medium text-slate-700">
        例行工作 · {routine.name} · {routine.enabled ? '已启用' : '已暂停'}
      </summary>
      <p className="mt-2 text-xs text-slate-500">{routineScheduleLabel(routine)}</p>
      <p className="mt-1 text-xs text-slate-500">
        {routine.nextRunAt ? `下次执行：${timeLabel(routine.nextRunAt)}` : '暂无后续执行时间'}
      </p>
      <ErrorNote error={error || routine.error} />
      <div className="mt-2 flex gap-2">
        <Button disabled={busy} onClick={() => void execute(true)}>
          立即执行
        </Button>
        <Button disabled={busy} onClick={() => void execute()}>
          {routine.enabled ? '暂停' : '启用'}
        </Button>
      </div>
    </details>
  );
}
