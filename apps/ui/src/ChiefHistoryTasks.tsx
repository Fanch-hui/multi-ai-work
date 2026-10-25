import { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { ChiefHistoryTaskList } from '../../../src/domain/chief-history-tasks.js';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, Confirm, ErrorNote, inputClass, timeLabel } from './components.js';
import { useResource } from './local-work/useResource.js';
import { ChiefHistoryTaskDetails } from './ChiefHistoryTaskDetails.js';

type Props = { data: Snapshot; mutate: Mutate };

export function ChiefHistoryTasks(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="min-w-0 border-b border-slate-100 pb-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm text-slate-600">历史任务</summary>
      {open && <ChiefHistoryTaskListPanel {...props} />}
    </details>
  );
}

export function ChiefHistoryTaskListPanel({ data, mutate }: Props) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [selectedId, setSelected] = useState<string>();
  const before = cursors.at(-1);
  const resource = useResource<ChiefHistoryTaskList>('chief.history.tasks.list', {
    query: query || undefined,
    before,
    limit: 20,
  });
  async function remove(contextId: string) {
    await mutate<{ deletedContextId: string }>('chief.history.tasks.delete', { contextId });
    setSelected(undefined);
    setCursors([]);
    resource.reload();
  }
  return (
    <section aria-label="历史任务" className="mt-3 grid min-w-0 gap-3">
      <form
        className="flex min-w-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
          setCursors([]);
          setSelected(undefined);
        }}
      >
        <input
          className={inputClass}
          aria-label="搜索历史任务"
          placeholder="搜索任务"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit">搜索</Button>
      </form>
      <ErrorNote error={resource.error} />
      {resource.loading && (
        <p role="status" className="text-xs text-slate-500">
          正在读取历史任务…
        </p>
      )}
      {resource.error && <Button onClick={resource.reload}>重新读取</Button>}
      {resource.value?.items.map((context) => {
        const expanded = selectedId === context.id;
        const workspace = data.workspaces.find((item) => item.id === context.workspaceId);
        return (
          <article key={context.id} className="min-w-0 rounded-xl border border-slate-200 p-3">
            <div className="flex min-w-0 items-start gap-2">
              <button
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
                aria-expanded={expanded}
                onClick={() => setSelected(expanded ? undefined : context.id)}
              >
                {expanded ? (
                  <ChevronDown size={16} className="mt-0.5 shrink-0" />
                ) : (
                  <ChevronRight size={16} className="mt-0.5 shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block break-words text-sm font-medium text-slate-800">
                    {context.kind === 'main' ? '主对话上下文' : context.title}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    {workspace?.name ?? '项目'} · {timeLabel(context.updatedAt)} ·{' '}
                    {context.partCount} 段 · {context.taskCount} 项任务
                    {context.activeTaskIds.length > 0 &&
                      ` · ${context.activeTaskIds.length} 项进行中`}
                  </span>
                </span>
              </button>
              {context.deletable && context.kind !== 'main' ? (
                <Confirm
                  title={`删除“${context.title}”？`}
                  description="将删除这项工作的任务记录和执行上下文。主对话中已显示的消息、交付成果和独立任务群会保留。"
                  actionLabel="删除历史任务"
                  onConfirm={() => remove(context.id)}
                >
                  <Button variant="ghost" aria-label={`删除历史任务：${context.title}`}>
                    <Trash2 size={15} />
                  </Button>
                </Confirm>
              ) : (
                <Button
                  variant="ghost"
                  disabled
                  title={context.deleteBlockedReason ?? '主对话上下文保留'}
                  aria-label={`无法删除：${context.deleteBlockedReason ?? '主对话上下文保留'}`}
                >
                  <Trash2 size={15} />
                </Button>
              )}
            </div>
            {expanded && (
              <ChiefHistoryTaskDetails
                key={context.id}
                contextId={context.id}
                data={data}
                mutate={mutate}
              />
            )}
          </article>
        );
      })}
      {resource.value && !resource.value.items.length && (
        <p className="text-sm text-slate-500">暂无匹配的历史任务。</p>
      )}
      {(cursors.length > 0 || resource.value?.nextBefore) && (
        <nav aria-label="历史任务分页" className="flex justify-between gap-2">
          <Button
            disabled={resource.loading || !cursors.length}
            onClick={() => {
              setCursors(cursors.slice(0, -1));
              setSelected(undefined);
            }}
          >
            上一页
          </Button>
          <Button
            disabled={resource.loading || !resource.value?.nextBefore}
            onClick={() => {
              setCursors([...cursors, resource.value!.nextBefore!]);
              setSelected(undefined);
            }}
          >
            下一页
          </Button>
        </nav>
      )}
    </section>
  );
}
