import type { Run, RunEvent } from '../../../src/domain/types.js';
import { runPerformance } from './run-performance.js';

export function RunPerformance({ run, events }: { run: Run; events: RunEvent[] }) {
  const timing = runPerformance(run, events);
  if (!timing) return null;
  const rows = [
    ['本轮总耗时', timing.elapsedMs],
    ['模型请求累计', timing.modelMs],
    ['首次流事件等待累计', timing.firstEventMs],
    ['首次输出等待累计', timing.firstOutputMs],
    ['工具调用就绪后等待', timing.toolStartWaitMs],
    ['工具授权核对', timing.authorizationMs],
    ['工作区排队', timing.workspaceQueueMs],
    ['网络排队', timing.networkQueueMs],
    ['审批等待', timing.approvalWaitMs],
    ['工具执行', timing.executionMs],
    ['结果处理', timing.processingMs],
    ['操作记录保存', timing.saveMs],
    ['检查点保存', timing.checkpointMs],
    ['模型结束后工具收尾', timing.earlyTailMs],
  ] as const;
  return (
    <div className="mt-3 rounded-lg bg-slate-50 p-3">
      <p className="font-medium text-slate-600">耗时明细</p>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="text-right tabular-nums">
                {value! < 1000 ? `${value!.toFixed(1)} ms` : `${(value! / 1000).toFixed(2)} s`}
              </dd>
            </div>
          ))}
      </dl>
      <p className="mt-2 text-pretty leading-5">
        分项按已加载记录累计，并行和重叠部分不相加；本轮总耗时独立计算。
      </p>
    </div>
  );
}
