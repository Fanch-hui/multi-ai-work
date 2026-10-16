import { ModalPresence } from "./ModalPresence.js";
import { PageSurface } from "./PageSurface.js";
import { useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, Pin, Plus, Search, Users } from "lucide-react";
import type { MemoryEntry, Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { Button, Empty, PageHeader, inputClass, timeLabel } from "./components.js";
import Avatar from "./Avatar.js";
import { MemoryEditor } from "./MemoryEditor.js";
import { MemoryNotebook } from './MemoryNotebook.js';
import { matchesMemoryQuery, memoryNotebooks, type MemoryNotebookData } from './memory-notebooks.js';

export function Memory({ data, mutate, headerLeading }: { data: Snapshot; mutate: Mutate; headerLeading?: ReactNode }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState<MemoryEntry | "new">();
  const notebook = memoryNotebooks(data).find(item => item.id === selectedId);
  const notebooks = memoryNotebooks(data, query);
  return <PageSurface headerLeading={headerLeading} contentClassName="px-7 pb-8" header={<PageHeader
    title={notebook ? notebook.bot ? `${notebook.name} 的记忆` : notebook.name : '记忆'}
    action={<Button variant="primary" onClick={() => setEditing('new')}><Plus size={16} />添加记忆</Button>} />}>
    {notebook ? <>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Button variant="ghost" onClick={() => setSelectedId('')}><ArrowLeft size={16} />全部成员</Button>
        {notebook.bot && <Avatar bot={notebook.bot} small />}
        <p className="text-sm tabular-nums text-slate-400">
          {notebook.entries.length} 条记忆
          {notebook.pinnedCount > 0 && ` · 置顶 ${notebook.pinnedCount} 条（约 ${notebook.pinnedTokens} / ${notebook.pinnedCapTokens} tokens）`}
          {notebook.bot?.memoryMode === 'off' && ' · 此成员已关闭记忆'}
        </p>
      </div>
      <MemoryNotebook key={notebook.id} notebook={notebook} data={data} mutate={mutate}
        edit={setEditing} add={() => setEditing('new')} />
    </> : <>
      <div className="mb-7 flex flex-wrap items-center gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-3 text-slate-400" size={16} />
          <input aria-label="搜索成员或记忆" className={`${inputClass} pl-9`} value={query}
            onChange={(event) => setQuery(event.target.value)} placeholder="搜索成员、主题、标签或记忆内容" />
        </div>
        <p className="text-sm text-slate-400">每位成员一个记忆空间，支持按主题折叠、置顶核心记忆与版本溯源。</p>
      </div>
      {notebooks.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {notebooks.map(item => <NotebookCard key={item.id} notebook={item} query={query} open={() => setSelectedId(item.id)} />)}
      </div> : <Empty title="没有匹配的成员或记忆" />}
    </>}
    <ModalPresence show={!!editing}>{editing && <MemoryEditor key={typeof editing === 'string' ? `new:${notebook?.id ?? ''}` : editing.id}
      data={data} mutate={mutate} target={notebook?.target} memory={editing === 'new' ? undefined : editing} close={() => setEditing(undefined)} />}</ModalPresence>
  </PageSurface>;
}

function NotebookCard({ notebook, query, open }: { notebook: MemoryNotebookData; query: string; open: () => void }) {
  const needle = query.trim().toLocaleLowerCase();
  const latest = notebook.entries[0];
  const preview = (needle ? notebook.entries.find(entry => matchesMemoryQuery(entry, needle)) : undefined) ?? latest;
  return <article className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-5">
    <div className="flex min-w-0 items-center gap-3">
      {notebook.target.scope === 'bot' ? <Avatar bot={notebook.bot} name={notebook.name} />
        : <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-slate-50 text-slate-500"><Users size={21} /></span>}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-balance text-sm font-medium text-slate-900">{notebook.name}</h2>
        <p className="mt-1 text-xs tabular-nums text-slate-400">
          {notebook.entries.length} 条记忆
          {notebook.pinnedCount > 0 && ` · 置顶 ${notebook.pinnedCount} 条（约 ${notebook.pinnedTokens} tokens）`}
          {notebook.bot?.archived && ' · 已归档'}
        </p>
      </div>
      {notebook.overflowIds.length > 0 && (
        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
          置顶超预算
        </span>
      )}
    </div>
    <p className="mt-4 line-clamp-2 min-h-12 whitespace-pre-wrap break-words text-pretty text-sm leading-6 text-slate-500">
      {preview?.content || (notebook.target.scope === 'bot' ? '尚无长期记忆' : '由管家维护团队公共约定与共享资料')}
    </p>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-xs tabular-nums text-slate-400">
        {preview?.pinned && <Pin size={12} className="text-blue-600" />}
        {preview?.topic && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{preview.topic}</span>}
        {latest ? timeLabel(latest.updatedAt) : ''}
      </span>
      <Button variant="ghost" className="ml-auto text-xs" onClick={open} aria-label={`打开${notebook.name}的记忆`}><BookOpen size={15} />打开记忆</Button>
    </div>
  </article>;
}
