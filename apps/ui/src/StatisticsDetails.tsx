import { useModalVisible } from './ModalPresence.js';
import { X } from 'lucide-react';
import { conversationStatistics, nonnegative } from './conversation-statistics.js';

const exact = (value?: number) => value === undefined ? '未知' : new Intl.NumberFormat('en').format(value);
const statusNames = { running: '正在工作中', waiting_approval: '等待批准', waiting_input: '等待回答', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const row = (label: string, value: string) => <div className="flex items-start justify-between gap-5"><dt className="text-slate-500">{label}</dt><dd className="text-right text-slate-700">{value}</dd></div>;

export function StatisticsDetails({ id, panel, stats, rate, close }: {
  id: string; panel: 'activity' | 'usage' | 'context'; stats: ReturnType<typeof conversationStatistics>; rate: string; close: () => void;
}) {
  const visible = useModalVisible();
  const { usage, context, latestRun: run } = stats;
  const title = panel === 'activity' ? '运行与模型请求' : panel === 'usage' ? '会话用量' : '当前上下文';
  return <section inert={!visible} data-state={visible ? "open" : "closed"} id={id} aria-label={title} className="statistics-popover absolute bottom-full left-1/2 z-40 mb-2 max-h-[min(60vh,420px)] w-[min(420px,calc(100vw-3rem))] -translate-x-1/2 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 text-xs shadow-lg">
      <div className="mb-3 flex items-center justify-between gap-4"><h3 className="font-medium text-slate-800">{title}</h3>
        <button type="button" className="rounded-md p-1 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500" aria-label="关闭统计详情" onClick={close}><X size={14} aria-hidden="true" /></button>
      </div>
      {panel === 'activity' && <>
        <dl className="space-y-2">
          {row('会话轮次', `${stats.turns} 轮`)}{row('累计运行', `${stats.runs} 次`)}
          {row('模型请求', stats.requests === undefined ? stats.missingReason : `${stats.requestsComplete ? '' : '已记录 '}${stats.requests} 次`)}
          {stats.unknownRequestRuns > 0 && row('请求记录覆盖', `${stats.unknownRequestRuns} 次运行缺记录`)}
          {row('其中摘要请求', !stats.summaryKnownRuns && stats.runs > 0 ? stats.missingReason : `${stats.summaryUnknownRuns ? '已记录 ' : ''}${stats.summaryRequests} 次`)}
          {stats.summaryUnknownRuns > 0 && row('摘要记录覆盖', `${stats.summaryUnknownRuns} 次运行缺记录`)}
          {row('最近运行状态', run ? statusNames[run.status] : '尚未运行')}{row('最近运行模型', run?.model ?? '未知')}
          {stats.rateFromPrevious && row('本次请求速率', stats.rateMissingReason)}
          {row(stats.rateFromPrevious ? '最近有效请求速率' : '请求速率', `${stats.ratePartial ? '部分请求 · ' : ''}${rate}`)}
          {stats.rateRun && <>
            {row('速率来源运行', stats.rateRun.id)}{row('速率来源模型', stats.rateRun.model ?? '未记录')}
            {stats.rateRequests !== undefined && row('速率样本', `${stats.rateRequests} 次已完成请求`)}
            {row('样本模型请求耗时', nonnegative(stats.modelDurationMs) ? `${(stats.modelDurationMs / 1000).toFixed(2)} 秒` : '未报告')}
          </>}
          {row('本次整体工作耗时', nonnegative(run?.inferenceDurationMs) ? `${(run.inferenceDurationMs / 1000).toFixed(2)} 秒` : '尚未结束或未报告')}
        </dl>
        <p className="mt-3 leading-relaxed text-slate-500">一轮对应一个会话任务；回答问题或继续任务可能有多次运行。请求数来自实际模型请求记录。</p>
        <p className="mt-2 leading-relaxed text-slate-500">速率采用同一批已完成模型请求的输出 tokens ÷ 请求耗时，包含首 token 等待，排除工具、审批及摘要耗时。最近有效数据保留其运行与模型来源。</p>
      </>}
      {panel === 'usage' && <>
        <dl className="space-y-2">
          {row('累计输入', `${exact(usage.input)}${usage.input === undefined ? '' : ' tok'}`)}
          {row('累计输出', `${exact(usage.output)}${usage.output === undefined ? '' : ' tok'}`)}
          {row('累计消耗', `${exact(usage.total)}${usage.total === undefined ? '' : ' tok'}`)}
          {row('缓存输入（包含于输入）', `${exact(usage.cached)}${usage.cached === undefined ? '' : ' tok'}`)}
          {row('缓存命中', usage.cachePercent === undefined ? usage.cacheInput === 0 ? '无输入样本' : stats.missingReason
            : `${usage.cacheComplete ? '' : '已报告部分 · '}${usage.cachePercent.toFixed(1)}%`)}
          {usage.cacheInput !== undefined && row('缓存样本输入', `${exact(usage.cacheInput)} tok`)}
          {usage.cacheTotalRequests > 0 && row('请求级缓存记录', `${usage.cacheRequests} / ${usage.cacheTotalRequests} 次请求`)}
          {usage.cacheLegacyTotalRuns > 0 && row('历史缓存记录', `${usage.cacheLegacyRuns} / ${usage.cacheLegacyTotalRuns} 次运行`)}
          {row('用量来源', usage.knownRuns === 0 ? '未报告' : usage.estimated ? '包含 App 估算' : '服务端报告')}
          {row('完整用量记录', `${usage.completeRuns} / ${stats.runs} 次运行`)}
        </dl>
        <p className="mt-3 leading-relaxed text-slate-500">累计当前会话的输入与输出，包含上下文摘要调用。缓存输入是输入的一部分，不重复计入总量。</p>
        {usage.missingRuns > 0 && <p className="mt-2 leading-relaxed text-slate-500">{usage.missingRuns} 次运行未报告完整用量，显示已知部分。</p>}
        <p className="mt-2 leading-relaxed text-slate-500">缓存命中率仅使用同时报告有效输入与缓存量的样本，按输入量加权；未报告缓存不等于零命中。</p>
      </>}
      {panel === 'context' && <>
        <dl className="space-y-2">
          {row('占用比例', context.percent === undefined ? '未知' : `${context.source === 'estimated' ? '约 ' : ''}${context.percent.toFixed(1)}%`)}
          {row('上下文 tokens', exact(context.used))}{row('完整窗口', exact(context.window))}
          {row('App 输入预算', exact(context.available))}{row('预留输出', exact(context.outputReserve))}
          {row('来源', context.source === 'estimated' ? 'App 估算' : context.source === 'reported' ? '原生运行时报告' : '未报告')}
        </dl>
        <p className="mt-3 leading-relaxed text-slate-500">展示最近一次运行的上下文记录；它与累计消耗分别计算。{context.source === 'estimated' ? '占用按请求前的估算 tokens ÷ 完整窗口计算。' : context.percent === undefined ? '当前运行时未提供可靠的上下文占用。' : '占用比例采用原生运行时报告。'}</p>
      </>}
    </section>;
}
