import { useEffect, useState } from 'react';
import type { ProcessRecord } from '../../../src/domain/types.js';
import { Button, ErrorNote, cn, timeLabel } from './components.js';
import { processRecordStatus } from './conversation-records.js';
import { errorMessage, request } from './api.js';

export function CommandRecords({ processes }: { processes: ProcessRecord[] }) {
  if (!processes.length) return null;
  const running = processes.filter((process) => process.status === 'running').length;
  return (
    <details className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        命令进程
        <span className="ml-2 text-xs font-normal tabular-nums text-slate-500">
          {processes.length} 条{running ? ` · ${running} 条仍在运行` : ''}
        </span>
      </summary>
      <div className="mt-3 grid min-w-0 gap-2">
        {processes.map((process) => (
          <CommandRecord key={process.id} process={process} />
        ))}
      </div>
    </details>
  );
}

function CommandRecord({ process }: { process: ProcessRecord }) {
  const [open, setOpen] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [output, setOutput] = useState<{ stdout: string; stderr: string; truncated: boolean }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError('');
    void request<{ stdout: string; stderr: string; truncated: boolean }>('processes.output', {
      id: process.id,
    })
      .then((result) => {
        if (active) setOutput(result);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [open, process.id, process.status, refresh]);
  return (
    <details
      className="min-w-0 border-t border-slate-100 pt-3 text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-slate-700">
        <span
          className={cn(
            'mr-2 font-medium',
            ['failed', 'timed_out', 'unknown'].includes(process.status)
              ? 'text-red-700'
              : 'text-slate-600',
          )}
        >
          {processRecordStatus(process)}
          {process.code != null && ` · 退出码 ${process.code}`}
        </span>
        <span className="break-all font-mono">{[process.command, ...process.args].join(' ')}</span>
      </summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 tabular-nums text-slate-500">
        <dt>开始</dt>
        <dd>{timeLabel(process.createdAt)}</dd>
        {process.endedAt && (
          <>
            <dt>结束</dt>
            <dd>{timeLabel(process.endedAt)}</dd>
          </>
        )}
        {process.signal && (
          <>
            <dt>退出信号</dt>
            <dd>{process.signal}</dd>
          </>
        )}
      </dl>
      {output?.stdout && <ProcessOutput title="标准输出" output={output.stdout} />}
      {output?.stderr && <ProcessOutput title="错误输出" output={output.stderr} />}
      {output?.truncated && <p className="mt-2 text-slate-500">显示已保存的部分输出。</p>}
      <ErrorNote error={error} />
      {process.status === 'running' && (
        <Button className="mt-3" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
          刷新输出
        </Button>
      )}
    </details>
  );
}

function ProcessOutput({ title, output }: { title: string; output: string }) {
  return (
    <div className="mt-3 min-w-0">
      <p className="mb-1 text-slate-500">{title}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-slate-600">
        {output}
      </pre>
    </div>
  );
}
