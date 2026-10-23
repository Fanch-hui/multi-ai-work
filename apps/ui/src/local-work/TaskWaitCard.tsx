import { useRef, useState } from 'react';
import type { TaskWait } from '../../../../src/domain/task-wait.js';
import { errorMessage } from '../api.js';
import type { Mutate } from '../store.js';
import { Button, ErrorNote } from '../components.js';

export function TaskWaitCard({
  wait,
  mutate,
  onBrowser,
  onComputer,
  resolved,
}: {
  wait: TaskWait;
  mutate: Mutate;
  onBrowser?: () => void;
  onComputer?: () => void;
  resolved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const submitting = useRef(false);
  async function resolve(cancel = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await mutate(cancel ? 'waits.cancel' : 'waits.resume', { id: wait.id });
      setDone(true);
      resolved?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (done || wait.status !== 'pending') return null;
  const browser = wait.kind === 'browser-handoff';
  const computer = wait.kind === 'computer-handoff';
  const openHandoff = computer ? onComputer : onBrowser;
  const handoff = (computer || browser) && openHandoff;
  return (
    <article className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <h3 className="text-sm font-medium text-slate-800">{wait.summary}</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        {browser && '请打开工作浏览器完成操作，再交回团队。'}
        {computer && '请完成本机应用操作，再交回团队继续原任务。'}
        {!browser && !computer && '继续处理后，团队将重新核对当前操作和权限。'}
      </p>
      <ErrorNote error={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        {handoff ? (
          <Button variant="primary" onClick={openHandoff}>
            {computer ? '打开电脑操作' : '打开工作浏览器'}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void resolve()}>
            继续处理
          </Button>
        )}
        <Button disabled={busy} onClick={() => void resolve(true)}>
          停止任务
        </Button>
      </div>
    </article>
  );
}
