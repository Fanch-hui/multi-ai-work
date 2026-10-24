import { useState } from 'react';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, inputClass } from './components.js';
import { errorMessage } from './api.js';

export function ChiefInputFeedback({
  data,
  messageId,
  mutate,
}: {
  data: Snapshot;
  messageId: string;
  mutate: Mutate;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = data.chief?.inputs.find((item) => item.messageId === messageId);
  const task = input
    ? data.tasks
        .filter((item) => input.taskIds.includes(item.id) || item.sourceMessageId === messageId)
        .at(-1)
    : undefined;
  const taskFailure =
    input?.status === 'dispatched' && task && ['failed', 'interrupted'].includes(task.status)
      ? task
      : undefined;
  if (!input || input.status === 'cancelled' || (input.status === 'dispatched' && !taskFailure))
    return null;
  const waiting = input.status === 'pending' || input.status === 'routing';
  const failed = input.status === 'failed' || !!taskFailure;
  async function act(method: string, fields: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await mutate(method, { id: input!.id, ...fields });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 grid gap-2 text-xs leading-5 text-slate-500" aria-label="消息处理状态">
      <p role={waiting ? 'status' : 'alert'} className={failed ? 'text-red-700' : undefined}>
        {waiting ? '正在接收…' : taskFailure?.error || input.error || input.question}
      </p>
      {input.status === 'clarification' && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim()) void act('chief.inputs.resolve', { answer: answer.trim() });
          }}
        >
          <input
            className={inputClass}
            aria-label="回复管家"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            disabled={busy}
          />
          <Button disabled={busy || !answer.trim()}>回复</Button>
        </form>
      )}
      <ErrorNote error={error} />
      <div className="flex justify-end gap-3">
        {failed && (
          <button
            type="button"
            className="text-blue-600 hover:underline disabled:opacity-50"
            disabled={busy || taskFailure?.reconciliationRequired}
            title={taskFailure?.reconciliationRequired ? '请在记录中先核查操作结果' : undefined}
            onClick={() => void act('chief.inputs.retry')}
          >
            重试
          </button>
        )}
        {!taskFailure && (
          <button
            type="button"
            className="hover:text-slate-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => void act('chief.inputs.cancel')}
          >
            取消
          </button>
        )}
      </div>
    </div>
  );
}
