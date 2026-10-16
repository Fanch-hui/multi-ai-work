import { MemorySource } from './MemorySource.js';
import { MemoryHistory } from './MemoryHistory.js';
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Pencil, Pin, Search, Sparkles, Trash2 } from 'lucide-react';
import type { MemoryEntry, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { groupMemoriesByTopic, matchesMemoryQuery, type MemoryNotebookData } from './memory-notebooks.js';
import { Button, Confirm, Empty, inputClass, timeLabel } from './components.js';

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function MemoryNotebook({ notebook, data, mutate, edit, add }: {
  notebook: MemoryNotebookData; data: Snapshot; mutate: Mutate; edit: (entry: MemoryEntry) => void; add: () => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsedTopics, setCollapsedTopics] = useState<Set<string>>(() => new Set());
  const [consolidating, setConsolidating] = useState(false);

  const entries = notebook.entries.filter(entry => matchesMemoryQuery(entry, query));
  const topicGroups = groupMemoriesByTopic(entries);
  const overflowSet = new Set(notebook.overflowIds);

  const reviewTasks = data.tasks.filter(task =>
    task.kind === 'memory-review'
    && (notebook.target.scope === 'bot'
      ? task.botId === notebook.target.ownerId
      : task.botId === data.settings.mainBotId),
  );
  const runningReview = reviewTasks.find(task => !['completed', 'failed', 'cancelled'].includes(task.status));
  const latestCompletedReview = [...reviewTasks]
    .filter(task => task.status === 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  async function triggerConsolidate() {
    setConsolidating(true);
    try {
      await mutate('memories.consolidate', {
        scope: notebook.target.scope,
        ownerId: notebook.target.ownerId,
      });
    } finally {
      setConsolidating(false);
    }
  }

  return <div className="mx-auto w-full max-w-4xl">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="relative max-w-sm flex-1">
        <Search className="absolute left-3 top-3 text-slate-400" size={16} />
        <input aria-label={`搜索${notebook.name}的记忆`} className={`${inputClass} pl-9`} value={query}
          onChange={event => setQuery(event.target.value)} placeholder="搜索内容、主题、摘要或标签" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {(runningReview || latestCompletedReview?.result) && (
          <span className="max-w-xs truncate text-xs text-slate-400">
            {runningReview ? '正在后台整理记忆…' : `上次整理：${latestCompletedReview?.result}`}
          </span>
        )}
        {notebook.entries.length > 0 && (
          <Button
            variant="ghost"
            className="text-xs"
            disabled={consolidating || !!runningReview}
            onClick={() => void triggerConsolidate()}
          >
            <Sparkles size={14} />
            {consolidating || runningReview ? '整理中…' : '整理记忆'}
          </Button>
        )}
      </div>
    </div>

    {notebook.overflowIds.length > 0 && (
      <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-xs leading-5 text-amber-800">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          置顶记忆估算占用 {notebook.pinnedTokens} tokens，已超出自动注入预算上限（{notebook.pinnedCapTokens} tokens）。
          标记为“未纳入全文”的置顶记忆将退化为摘要目录，由智能体按需召回。
        </div>
      </div>
    )}

    {topicGroups.length ? <div className="space-y-6">
      {topicGroups.map(group => {
        const isCollapsed = collapsedTopics.has(group.topic);
        return <div key={group.topic} className="rounded-2xl border border-slate-100 bg-white">
          <button
            type="button"
            onClick={() => setCollapsedTopics(prev => {
              const next = new Set(prev);
              if (next.has(group.topic)) next.delete(group.topic); else next.add(group.topic);
              return next;
            })}
            className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-5 py-3 text-left text-xs font-medium text-slate-600 hover:bg-slate-50/60"
          >
            <span className="flex items-center gap-1.5">
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span>{group.topic}</span>
            </span>
            <span className="tabular-nums text-slate-400">{group.entries.length} 条</span>
          </button>
          {!isCollapsed && <div className="divide-y divide-slate-100 px-5">
            {group.entries.map(entry => <section key={entry.id} className="py-5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {entry.pinned && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    <Pin size={11} />已置顶
                  </span>
                )}
                {overflowSet.has(entry.id) && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    未纳入全文
                  </span>
                )}
                {entry.tags?.map(tag => (
                  <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">#{tag}</span>
                ))}
                {entry.summary && entry.summary.trim() !== entry.content.trim() && (
                  <span className="text-xs text-slate-400">摘要：{entry.summary}</span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-pretty text-sm leading-7 text-slate-700">{entry.content}</p>
              {entry.reviewSuggestion && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs text-slate-600">
                  <span>后台整理建议修订：{entry.reviewSuggestion.content}</span>
                  <Button variant="ghost" className="h-7 px-2 text-xs text-blue-700" onClick={() => void mutate('memories.save', {
                    ...entry,
                    content: entry.reviewSuggestion!.content,
                    topic: entry.reviewSuggestion!.topic ?? entry.topic,
                    summary: entry.reviewSuggestion!.summary ?? entry.summary,
                  })}>采纳建议</Button>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                <span>{scopeLabel(entry, data)}</span>
                <span>v{entry.revision}</span>
                {entry.status === 'candidate' && <span>整理中</span>}
                <span className="tabular-nums">
                  自动注入 {entry.usage?.autoInjectedCount ?? 0} 次 · 主动读取 {entry.usage?.activeReadCount ?? 0} 次
                </span>
                {entry.usage?.lastRecalledAt && (
                  <span className="tabular-nums">最后召回 {timeLabel(entry.usage.lastRecalledAt)}</span>
                )}
                {isStaleMemory(entry) && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">很久未召回</span>
                )}
                <time className="tabular-nums" dateTime={entry.updatedAt}>{timeLabel(entry.updatedAt)}</time>
                <div className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    className={`size-8 min-h-8 p-0 ${entry.pinned ? 'text-blue-600' : ''}`}
                    aria-label={entry.pinned ? `取消置顶${notebook.name}的记忆` : `置顶${notebook.name}的记忆`}
                    title={entry.pinned ? '取消置顶' : '置顶为核心记忆'}
                    onClick={() => void mutate('memories.pin', { id: entry.id, pinned: !entry.pinned })}
                  >
                    <Pin size={15} />
                  </Button>
                  <Button variant="ghost" className="size-8 min-h-8 p-0" aria-label={`编辑${notebook.name}的记忆`} onClick={() => edit(entry)}><Pencil size={15} /></Button>
                  <Confirm title="删除这条记忆？" description="团队之后将不再使用这条记忆。" actionLabel="删除记忆"
                    onConfirm={() => mutate('memories.revoke', { id: entry.id })}>
                    <Button variant="ghost" className="size-8 min-h-8 p-0" aria-label={`删除${notebook.name}的记忆`}><Trash2 size={15} /></Button>
                  </Confirm>
                </div>
              </div>
              <details className="mt-2 text-xs text-slate-500" onToggle={event => {
                const open = event.currentTarget.open;
                setExpanded(previous => { const next = new Set(previous); if (open) next.add(entry.id); else next.delete(entry.id); return next; });
              }}>
                <summary className="cursor-pointer">来源与使用范围</summary>
                {entry.allowedConversationIds.length > 0 && <p className="mt-3 leading-5">用于：{entry.allowedConversationIds
                  .map(id => data.conversations.find(room => room.id === id)?.name || '已删除会话').join('、')}</p>}
                {expanded.has(entry.id) && (
                  <>
                    {entry.sourceIds.map(id => <MemorySource key={id} id={id} loaded={data.messages.find(message => message.id === id)} version={entry} />)}
                    <MemoryHistory memory={entry} data={data} />
                  </>
                )}
              </details>
            </section>)}
          </div>}
        </div>;
      })}
    </div> : <Empty title={query ? '没有匹配的内容' : '尚无长期记忆'}
      description={query ? undefined : '保存稳定的偏好、工作约定和已确认事实。'}
      action={!query ? <Button onClick={add}>添加记忆</Button> : undefined} />}
  </div>;
}

function scopeLabel(entry: MemoryEntry, data: Snapshot) {
  if (entry.scope === 'team') return `团队会话 · ${data.conversations.find(room => room.id === entry.ownerId)?.name || '已删除会话'}`;
  return entry.scope === 'shared' ? '共享资料' : '成员专用';
}

function isStaleMemory(entry: MemoryEntry): boolean {
  const ref = entry.usage?.lastRecalledAt ?? entry.updatedAt;
  const ts = Date.parse(ref);
  return Number.isFinite(ts) && Date.now() - ts > STALE_MS;
}
