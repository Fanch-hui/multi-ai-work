import { useModalVisible } from './ModalPresence.js';
import { Circle, Database, Gauge, X } from 'lucide-react';
import { conversationStatistics, nonnegative } from './conversation-statistics.js';

const exact = (value?: number) => value === undefined ? '—' : new Intl.NumberFormat('en').format(value);
const tokens = (value?: number) => value === undefined ? '—' : `${exact(value)} tok`;
const duration = (ms?: number) => !nonnegative(ms) ? '—' : ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round(ms % 60000 / 1000)} 秒`;
const row = (label: string, value: string) => <div className="flex items-start justify-between gap-5"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 break-words text-right text-slate-700">{value}</dd></div>;

export function StatisticsDetails({ id, panel, stats, rate, close }: {
  id: string; panel: 'activity' | 'usage' | 'context'; stats: ReturnType<typeof conversationStatistics>; rate: string; close: () => void;
}) {
  const visible = useModalVisible();
  const { usage, context } = stats;
  const title = panel === 'activity' ? '会话统计' : panel === 'usage' ? 'Token 用量' : '上下文';
  const Icon = panel === 'activity' ? Gauge : panel === 'usage' ? Database : Circle;
  const percent = context.percent === undefined ? '—' : `${context.source === 'estimated' ? '约 ' : ''}${Math.round(context.percent)}%`;
  return <section inert={!visible} data-state={visible ? 'open' : 'closed'} id={id} aria-label={title}
    className="statistics-popover absolute bottom-full left-1/2 z-40 mb-3 max-h-[min(60vh,420px)] w-[min(360px,calc(100vw-3rem))] -translate-x-1/2 overflow-y-auto rounded-2xl border border-slate-200/70 bg-white p-5 text-sm shadow-lg">
    <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
      <h3 className="flex items-center gap-2 font-medium text-slate-900"><Icon size={16} aria-hidden="true" />{title}</h3>
      {panel === 'usage' && <span className="ml-auto text-slate-900">{tokens(usage.total)}</span>}
      {panel === 'context' && <span className="ml-auto text-slate-900">{percent}</span>}
      <button type="button" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500" aria-label="关闭统计详情" onClick={close}><X size={14} aria-hidden="true" /></button>
    </div>
    {panel === 'activity' && <ActivityDetails stats={stats} rate={rate} />}
    {panel === 'usage' && <UsageDetails stats={stats} />}
    {panel === 'context' && <ContextDetails stats={stats} />}

  </section>;
}

function ActivityDetails({ stats, rate }: { stats: ReturnType<typeof conversationStatistics>; rate: string }) {
  return <>
      <dl className="space-y-3">
        {row('会话轮次', `${stats.turns} 轮`)}
        {row('模型请求', stats.requests === undefined ? '—' : `${stats.requests} 次`)}
        {row(stats.rateFromPrevious ? '最近有效请求速率' : '请求速率', rate)}
        {row('速率样本合计耗时', duration(stats.modelDurationMs))}
      </dl>
      <details className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <summary className="cursor-pointer">统计说明</summary>
        <dl className="mt-3 space-y-2">
          {row('累计运行', `${stats.runs} 次`)}
          {row('摘要请求', stats.summaryKnownRuns ? `${stats.summaryRequests} 次` : '—')}
          {row('请求记录覆盖', `${stats.runs - stats.unknownRequestRuns} / ${stats.runs} 次运行`)}
          {stats.rateRequests !== undefined && row('速率样本', `${stats.rateRequests} 次请求`)}
          {stats.rateRun && <>{row('速率来源模型', stats.rateRun.model ?? '未记录')}{row('速率来源运行', stats.rateRun.id)}</>}
          {stats.rateFromPrevious && row('当前模型', stats.latestRun?.model ?? '未记录')}
        </dl>
        <p className="mt-3 leading-relaxed">请求数含重试和摘要。速率为已完成主请求的输出除以请求耗时，包含首 token 等待；{stats.rateFromPrevious ? '当前运行暂无有效速率，展示最近有效运行。' : '采用最近有效运行的配对样本。'}</p>
        {stats.unknownRequestRuns > 0 && <p className="mt-2">{stats.unknownRequestRuns} 次运行没有完整请求记录，次数显示已记录部分。</p>}
      </details>
    </>;
}

function UsageDetails({ stats }: { stats: ReturnType<typeof conversationStatistics> }) {
  const { usage } = stats;
  const uncached = usage.cacheComplete && usage.input !== undefined && usage.cached !== undefined ? usage.input - usage.cached : undefined;
  return <>
      <dl className="space-y-3">
        {row('缓存命中', usage.cachePercent === undefined ? '—' : `${usage.cachePercent.toFixed(1)}%`)}
        {row(uncached === undefined ? '输入' : '未缓存输入', tokens(uncached ?? usage.input))}
        {row('缓存读取', tokens(usage.cached))}
        {row('输出', tokens(usage.output))}
      </dl>
      {!usage.complete && <p className="mt-3 text-xs text-slate-500">用量为已报告部分</p>}
      <details className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <summary className="cursor-pointer">统计说明</summary>
        <dl className="mt-3 space-y-2">
          {row('缓存样本输入', tokens(usage.cacheInput))}
          {usage.cacheTotalRequests > 0 && row('请求级缓存记录', `${usage.cacheRequests} / ${usage.cacheTotalRequests} 次请求`)}
          {usage.cacheLegacyTotalRuns > 0 && row('原生与历史缓存记录', `${usage.cacheLegacyRuns} / ${usage.cacheLegacyTotalRuns} 次运行`)}
          {row('完整用量记录', `${usage.completeRuns} / ${stats.runs} 次运行`)}
          {row('用量来源', usage.knownRuns === 0 ? '未报告' : usage.estimated ? '包含估算' : '服务端报告')}
        </dl>
        <p className="mt-3 leading-relaxed">含摘要调用。缓存命中按配对样本输入加权；缓存读取包含在输入中，总量为输入加输出。</p>
        {!usage.cacheComplete && <p className="mt-2">缓存样本覆盖部分请求，命中率以这里的缓存样本输入为分母。</p>}
        {usage.missingRuns > 0 && <p className="mt-2">{usage.missingRuns} 次运行用量不完整，可能含失败、中断或尚未报告的请求。</p>}
      </details>
    </>;
}

function ContextDetails({ stats }: { stats: ReturnType<typeof conversationStatistics> }) {
  const { context } = stats;
  return <>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={context.percent === undefined ? undefined : Math.min(100, context.percent)}>
        {context.percent !== undefined && <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, context.percent)}%` }} />}
      </div>
      <dl className="space-y-3">{row('已用 / 窗口', `${exact(context.used)} / ${exact(context.window)}`)}{row('预留输出', tokens(context.outputReserve))}</dl>
      <p className="mt-4 text-xs leading-relaxed text-slate-500">{context.source === 'estimated' ? '请求前估算' : context.source === 'reported' ? '原生运行时快照' : '暂无上下文记录'}{context.percent !== undefined && context.percent > 100 ? ' · 已超过窗口' : ''}</p>
    </>;
}
