import { useEffect, useState } from 'react';
import type { Run, RunEvent, RunEventPage, Task } from '../../../src/domain/types.js';
import { request, errorMessage } from './api.js';
import { Badge, Button, ErrorNote, cn, timeLabel } from './components.js';
import { taskRecordActions } from './conversation-records.js';
import { RunPerformance } from './RunPerformance.js';

const labels: Record<string, string> = {
  tool: '工具',
  approval: '审批',
  usage: '用量',
  context: '上下文',
  compaction: '整理',
  status: '状态',
};
const mergeEvents = (previous: RunEvent[], incoming: RunEvent[]) =>
  [...new Map([...previous, ...incoming].map((event) => [event.id, event])).values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

export function RunRecords({ run, recent, task }: { run: Run; recent: RunEvent[]; task: Task }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [cursor, setCursor] = useState<number>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const currentEvents = recent.filter((event) => event.runId === run.id && event.type !== 'text');
  const latestId = currentEvents.at(-1)?.id;
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true);
    setError('');
    void request<RunEventPage>('runs.events', { id: run.id })
      .then((page) => {
        if (!active) return;
        setEvents((previous) => mergeEvents(previous, page.events));
        if (!loaded) setCursor(page.nextCursor);
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [open, run.id, latestId, run.status, refresh]);
  async function earlier() {
    setBusy(true);
    setError('');
    try {
      const page = await request<RunEventPage>('runs.events', { id: run.id, cursor });
      setEvents((previous) => mergeEvents(page.events, previous));
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const records = mergeEvents(events, currentEvents);
  const actions = taskRecordActions({ runs: [run], events: records }, task);
  const usage = run.usage?.source !== 'unknown' ? run.usage : undefined;
  return (
    <details
      className="min-w-0 border-t border-slate-100 pt-3 text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-slate-600">
        <span className="mr-2 tabular-nums">{timeLabel(run.createdAt)}</span>
        <Badge status={run.status} />
        {!!actions.length && (
          <span className="ml-2 tabular-nums">
            {actions.length} 项{loaded ? '' : '近期'}操作
          </span>
        )}
      </summary>
      {open && (
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3" aria-busy={busy}>
          {run.error && (
            <div className="rounded-lg bg-red-50 p-3 text-pretty leading-5 text-red-700">
              <p className="mb-1 font-medium">本轮执行错误</p>
              {run.error}
            </div>
          )}
          {actions.map((action) => (
            <details key={action.event.id} className="min-w-0">
              <summary className="cursor-pointer break-words leading-5 text-slate-700">
                {action.title}
                <span
                  className={cn(
                    'ml-2',
                    ['失败', '命令失败', '命令超时'].includes(action.status)
                      ? 'text-red-700'
                      : 'text-slate-500',
                  )}
                >
                  {action.status} ·{' '}
                  <span className="tabular-nums">{timeLabel(action.event.createdAt)}</span>
                </span>
              </summary>
              {typeof action.event.data.error === 'string' && (
                <p className="mt-2 text-pretty leading-5 text-red-700">
                  操作错误：{action.event.data.error}
                </p>
              )}
              <EventData event={action.event} />
            </details>
          ))}
          {busy && (
            <p role="status" className="text-slate-500">
              正在读取记录…
            </p>
          )}
          {!busy && loaded && !actions.length && (
            <p className="text-slate-500">本轮暂无工具操作。</p>
          )}
          <ErrorNote error={error} />
          {cursor !== undefined && (
            <Button disabled={busy} onClick={() => void earlier()}>
              加载更早操作
            </Button>
          )}
          {error && (
            <Button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
              重新读取
            </Button>
          )}
          <details className="min-w-0 border-t border-slate-100 pt-3 text-slate-500">
            <summary className="cursor-pointer">模型用量与诊断详情</summary>
            <p className="mt-3 tabular-nums">
              输入 {usage?.inputTokens ?? '未知'} · 输出 {usage?.outputTokens ?? '未知'} tokens
              {usage?.source === 'estimated' && '（估计）'}
            </p>
            {!usage && run.confirmedUsage && (
              <p className="mt-1 tabular-nums">
                已确认部分：输入 {run.confirmedUsage.inputTokens ?? '未知'} · 输出{' '}
                {run.confirmedUsage.outputTokens ?? '未知'} tokens
              </p>
            )}
            <RunPerformance run={run} events={records} />
            <div className="mt-3 grid gap-2">
              {records.map((event) => (
                <details key={event.id} className="min-w-0">
                  <summary className="cursor-pointer">
                    {labels[event.type] ?? event.type} ·{' '}
                    <span className="tabular-nums">{timeLabel(event.createdAt)}</span>
                  </summary>
                  <EventData event={event} />
                </details>
              ))}
            </div>
          </details>
        </div>
      )}
    </details>
  );
}

function EventData({ event }: { event: RunEvent }) {
  return (
    <pre className="mt-2 min-w-0 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-slate-600">
      {JSON.stringify(event.data, null, 2)}
    </pre>
  );
}
