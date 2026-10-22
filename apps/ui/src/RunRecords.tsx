import { useState } from 'react';
import type { Run, RunEvent, Task } from '../../../src/domain/types.js';
import { Button, ErrorNote, cn, timeLabel } from './components.js';
import { taskRecordActions } from './conversation-records.js';
import { RunPerformance } from './RunPerformance.js';
import { useRunRecords } from './use-run-records.js';
import { mergeRecordEvents, workRecordEvents } from './work-record-events.js';

export function RunRecords({
  run,
  recent,
  task,
  defaultOpen = false,
}: {
  run: Run;
  recent: RunEvent[];
  task: Task;
  defaultOpen?: boolean;
}) {
  const [selectedOpen, setOpen] = useState<boolean>();
  const open = selectedOpen ?? defaultOpen;
  const current = workRecordEvents(recent.filter((event) => event.runId === run.id));
  const page = useRunRecords(run, open, current.at(-1)?.id, 'work');
  const records = mergeRecordEvents(current, page.events);
  const actions = taskRecordActions({ runs: [run], events: records }, task);
  return (
    <details
      open={open}
      className="min-w-0 border-t border-slate-100 pt-3 text-xs"
      onToggle={(event) => {
        if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer text-slate-600">
        <span className="mr-2 tabular-nums">{timeLabel(run.createdAt)}</span>
        工作过程 · {run.id === task.runIds.at(-1) || defaultOpen ? '最新一轮' : '历史轮次'}
        {!!actions.length && (
          <span className="ml-2 tabular-nums">
            {actions.length} 项{page.loaded ? '' : '近期'}操作
          </span>
        )}
      </summary>
      <div className="mt-3 grid min-w-0 grid-cols-1 gap-3" aria-busy={page.busy}>
        {run.error && (
          <p className="rounded-lg bg-red-50 p-3 text-pretty leading-5 text-red-700">
            本轮执行错误：{run.error}
          </p>
        )}
        <ol className="grid min-w-0 gap-2" aria-label="本轮工作过程">
          {actions.map((action) => (
            <li key={action.key} className="min-w-0 rounded-lg bg-slate-50 px-3 py-2 leading-5">
              <span className="break-words text-slate-700">{action.title}</span>
              {action.status && (
                <span
                  className={cn(
                    'ml-2',
                    action.status === '失败' ? 'text-red-700' : 'text-slate-500',
                  )}
                >
                  · {action.status}
                </span>
              )}
              <time dateTime={action.event.createdAt} className="ml-2 tabular-nums text-slate-400">
                {timeLabel(action.event.createdAt)}
              </time>
            </li>
          ))}
        </ol>
        {!page.busy && page.loaded && !actions.length && (
          <p className="text-slate-500">本轮暂无工具操作。</p>
        )}
        <RecordPageControls page={page} />
        <RunTechnicalDetails run={run} recent={recent} visible={open} />
      </div>
    </details>
  );
}

function RunTechnicalDetails({
  run,
  recent,
  visible,
}: {
  run: Run;
  recent: RunEvent[];
  visible: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = recent.filter((event) => event.runId === run.id && event.type !== 'text');
  const page = useRunRecords(run, open && visible, current.at(-1)?.id);
  const records = mergeRecordEvents(current, page.events);
  const usage = run.usage?.source !== 'unknown' ? run.usage : undefined;
  return (
    <details
      className="min-w-0 border-t border-slate-100 pt-3 text-slate-500"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">技术详情 · 模型用量与原始诊断</summary>
      {open && (
        <div className="mt-3 grid min-w-0 gap-3">
          <p className="tabular-nums">
            输入 {usage?.inputTokens ?? '未知'} · 输出 {usage?.outputTokens ?? '未知'} tokens
            {usage?.source === 'estimated' && '（估计）'}
          </p>
          {!usage && run.confirmedUsage && (
            <p className="tabular-nums">
              已确认部分：输入 {run.confirmedUsage.inputTokens ?? '未知'} · 输出{' '}
              {run.confirmedUsage.outputTokens ?? '未知'} tokens
            </p>
          )}
          <RunPerformance run={run} events={records} />
          {records.map((event) => (
            <details key={event.id} className="min-w-0">
              <summary className="cursor-pointer">
                {eventLabels[event.type] ?? event.type} ·{' '}
                <span className="tabular-nums">{timeLabel(event.createdAt)}</span>
              </summary>
              <pre className="mt-2 min-w-0 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-slate-600">
                {JSON.stringify(event.data, null, 2)}
              </pre>
            </details>
          ))}
          <RecordPageControls page={page} diagnostic />
        </div>
      )}
    </details>
  );
}

function RecordPageControls({
  page,
  diagnostic = false,
}: {
  page: ReturnType<typeof useRunRecords>;
  diagnostic?: boolean;
}) {
  return (
    <>
      {page.busy && (
        <p role="status" className="text-slate-500">
          正在读取记录…
        </p>
      )}
      <ErrorNote error={page.error} />
      {page.cursor !== undefined && (
        <Button disabled={page.busy} onClick={() => void page.earlier()}>
          {diagnostic ? '加载更早诊断' : '加载更早操作'}
        </Button>
      )}
      {page.error && (
        <Button disabled={page.busy} onClick={page.refresh}>
          重新读取
        </Button>
      )}
    </>
  );
}

const eventLabels: Record<string, string> = {
  tool: '工具',
  approval: '审批',
  usage: '用量',
  context: '上下文',
  compaction: '整理',
  status: '状态',
};
