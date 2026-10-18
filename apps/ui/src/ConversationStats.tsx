import { ModalPresence } from './ModalPresence.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Circle, Database, Gauge } from 'lucide-react';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import { conversationStatistics } from './conversation-statistics.js';
import { StatisticsDetails } from './StatisticsDetails.js';
import { ContextCompactionControl } from './ContextCompactionControl.js';
import type { Mutate } from './store.js';

const compact = (value?: number) => value === undefined ? '未知' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
type Panel = 'activity' | 'usage' | 'context';

export function ConversationStats({ data, conversation, mutate }: { data: Snapshot; conversation: Conversation; mutate?: Mutate }) {
  const stats = conversationStatistics(data, conversation);
  const { usage, context } = stats;
  const [panel, setPanel] = useState<Panel>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  useEffect(() => { setPanel(undefined); }, [conversation.id]);
  useEffect(() => {
    if (!panel) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setPanel(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPanel(undefined); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [panel]);
  const toggle = (next: Panel, element: HTMLButtonElement) => { trigger.current = element; setPanel(panel === next ? undefined : next); };
  const rate = stats.rate === undefined ? stats.rateMissingReason : `${stats.rateEstimated ? '约 ' : ''}${stats.rate.toFixed(1)} tok/s`;
  const requests = stats.requests === undefined ? '' : ` ${stats.requests} 次请求`;
  const partial = !stats.requestsComplete || !usage.complete || !usage.cacheComplete;
  const buttonClass = 'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 whitespace-nowrap hover:bg-slate-100 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
  return <div ref={root} className="relative mt-2 text-xs tabular-nums text-slate-400" aria-label="当前会话运行统计">
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <button type="button" className={`${buttonClass} ${panel === 'activity' ? 'bg-slate-100 text-slate-600' : ''}`} aria-expanded={panel === 'activity'} aria-controls={panelId}
        aria-label="查看运行与模型请求详情" title={stats.rateRun ? `速率来源：${stats.rateFromPrevious ? '最近有效运行' : '本次运行'} ${stats.rateRun.id} · 模型 ${stats.rateRun.model ?? '未记录'}` : undefined}
        onClick={event => toggle('activity', event.currentTarget)}>
        <Gauge size={13} aria-hidden="true" />{stats.turns} 轮{requests}{stats.rate !== undefined && <span>· {rate}</span>}
      </button>
      <button type="button" className={`${buttonClass} ${panel === 'usage' ? 'bg-slate-100 text-slate-600' : ''}`} aria-expanded={panel === 'usage'} aria-controls={panelId}
        aria-label="查看会话用量详情" onClick={event => toggle('usage', event.currentTarget)}>
        <Database size={13} aria-hidden="true" />{usage.total === undefined ? '用量未知' : `${usage.estimated ? '约 ' : ''}${compact(usage.total)} tok`}
        {usage.cachePercent !== undefined && <span>· 缓存 {usage.cachePercent.toFixed(1)}%</span>}
        {partial && usage.total !== undefined && <span className="h-1 w-1 rounded-full bg-slate-400" title="部分数据，点击查看统计说明" aria-label="部分数据" />}

      </button>
      <button type="button" className={`${buttonClass} ${panel === 'context' ? 'bg-slate-100 text-slate-600' : ''}`} aria-expanded={panel === 'context'} aria-controls={panelId}
        aria-label="查看当前上下文详情" onClick={event => toggle('context', event.currentTarget)}>
        <Circle size={13} aria-hidden="true" /> {context.percent === undefined ? '未知' : `${context.source === 'estimated' ? '约 ' : ''}${Math.round(context.percent)}%`}
      </button>
    </div>
    <ModalPresence show={!!panel}>{panel && <StatisticsDetails id={panelId} panel={panel} stats={stats} rate={rate}
      contextAction={mutate && <ContextCompactionControl key={conversation.id} data={data} conversation={conversation} mutate={mutate} />}
      close={() => { setPanel(undefined); trigger.current?.focus(); }} />}</ModalPresence>
  </div>;
}
