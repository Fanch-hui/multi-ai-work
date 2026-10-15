import { useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import type { MemoryEntry, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import type { MemoryNotebookData } from './memory-notebooks.js';
import { Button, Confirm, Empty, inputClass, timeLabel } from './components.js';

export function MemoryNotebook({ notebook, data, mutate, edit, add }: {
  notebook: MemoryNotebookData; data: Snapshot; mutate: Mutate; edit: (entry: MemoryEntry) => void; add: () => void;
}) {
  const [query, setQuery] = useState('');
  const entries = notebook.entries.filter(entry => entry.content.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="mx-auto w-full max-w-4xl">
    <div className="relative mb-6 max-w-sm">
      <Search className="absolute left-3 top-3 text-slate-400" size={16} />
      <input aria-label={`搜索${notebook.name}的记忆`} className={`${inputClass} pl-9`} value={query}
        onChange={event => setQuery(event.target.value)} placeholder="搜索内容" />
    </div>
    {entries.length ? <div className="divide-y divide-slate-100">
      {entries.map(entry => <section key={entry.id} className="py-5 first:pt-0">
        <p className="whitespace-pre-wrap break-words text-pretty text-sm leading-7 text-slate-700">{entry.content}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>{scopeLabel(entry, data)}</span>
          {entry.status === 'candidate' && <span>整理中</span>}
          <time className="tabular-nums" dateTime={entry.updatedAt}>{timeLabel(entry.updatedAt)}</time>
          <div className="ml-auto flex gap-1">
            <Button variant="ghost" className="size-8 min-h-8 p-0" aria-label={`编辑${notebook.name}的记忆`} onClick={() => edit(entry)}><Pencil size={15} /></Button>
            <Confirm title="删除这条记忆？" description="团队之后将不再使用这条记忆。" actionLabel="删除记忆"
              onConfirm={() => mutate('memories.revoke', { id: entry.id })}>
              <Button variant="ghost" className="size-8 min-h-8 p-0" aria-label={`删除${notebook.name}的记忆`}><Trash2 size={15} /></Button>
            </Confirm>
          </div>
        </div>
        {(entry.sourceIds.length > 0 || entry.allowedConversationIds.length > 0) && <details className="mt-2 text-xs text-slate-500">
          <summary className="cursor-pointer">来源与使用范围</summary>
          {entry.allowedConversationIds.length > 0 && <p className="mt-3 leading-5">用于：{entry.allowedConversationIds
            .map(id => data.conversations.find(room => room.id === id)?.name || '已删除会话').join('、')}</p>}
          {entry.sourceIds.map(id => <blockquote key={id} className="mt-3 rounded-lg bg-slate-50 p-3 text-pretty leading-5">
            {data.messages.find(message => message.id === id)?.content || '来源消息已删除'}
          </blockquote>)}
        </details>}
      </section>)}
    </div> : <Empty title={query ? '没有匹配的内容' : '尚无长期记忆'}
      description={query ? undefined : '保存稳定的偏好、工作约定和已确认事实。'}
      action={!query ? <Button onClick={add}>添加记忆</Button> : undefined} />}
  </div>;
}

function scopeLabel(entry: MemoryEntry, data: Snapshot) {
  if (entry.scope === 'team') return `团队会话 · ${data.conversations.find(room => room.id === entry.ownerId)?.name || '已删除会话'}`;
  return entry.scope === 'shared' ? '共享资料' : '成员专用';
}
