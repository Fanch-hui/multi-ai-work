import { useState } from 'react';
import { ChevronDown, History, Plus } from 'lucide-react';
import type { ChiefContextView } from '../../../src/domain/chief-work.js';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote, Field, inputClass, Modal } from './components.js';
import { focusedChiefContext } from './chief-work.js';
import { composerDrafts } from './composer-drafts.js';
import { errorMessage } from './api.js';
import { ChiefHistorySearch } from './ChiefHistorySearch.js';

export function ChiefWorkSelector({
  data,
  mutate,
  onSelectConversation,
}: {
  data: Snapshot;
  mutate: Mutate;
  onSelectConversation: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [workspaceId, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const context = focusedChiefContext(data);
  const project = data.workspaces.find((item) => item.id === context?.workspaceId);
  const chief = data.chief;
  if (!chief) return null;
  const contexts = chief.contexts.filter(
    (item) =>
      (!workspaceId || item.workspaceId === workspaceId) &&
      item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const histories = data.conversations.filter(
    (room) =>
      room.chiefRole === 'history' &&
      room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  async function select(id: string) {
    setBusy(true);
    setError('');
    try {
      await mutate('chief.contexts.activate', { id });
      composerDrafts.edit(chief!.homeConversationId, { targetContextId: id });
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError('');
    try {
      const created = await mutate<ChiefContextView>('chief.contexts.create', {
        title: query.trim() || undefined,
        workspaceId: workspaceId || context?.workspaceId || data.workspaces[0]?.id,
      });
      composerDrafts.edit(chief!.homeConversationId, { targetContextId: created.id });
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto w-full max-w-4xl">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs text-slate-500 hover:bg-slate-50"
        aria-label="选择当前事项和项目"
      >
        <span className="min-w-0 flex-1 truncate">
          当前事项：{context?.title || '开始新事项'}
          {project ? ` · ${project.name}` : ''}
        </span>
        {!!context?.activeTaskIds.length && <span className="shrink-0 text-blue-600">进行中</span>}
        <ChevronDown size={13} className="shrink-0" />
      </button>
      <Modal open={open} onOpenChange={setOpen} title="工作事项">
        <div className="grid gap-4">
          <input
            className={inputClass}
            aria-label="搜索或命名工作事项"
            placeholder="搜索事项，或输入新事项名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Field label="项目">
            <select
              className={inputClass}
              value={workspaceId}
              onChange={(event) => setWorkspace(event.target.value)}
            >
              <option value="">全部项目</option>
              {data.workspaces.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorNote error={error} />
          <Button disabled={busy} onClick={() => void create()}>
            <Plus size={14} />
            开始新事项
          </Button>
          <div className="grid max-h-72 gap-1 overflow-auto" aria-label="已有工作事项">
            {contexts.map((item) => (
              <button
                key={item.id}
                disabled={busy}
                onClick={() => void select(item.id)}
                aria-pressed={item.id === context?.id}
                className="flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {data.workspaces.find((project) => project.id === item.workspaceId)?.name}
                </span>
              </button>
            ))}
          </div>
          {!!histories.length && (
            <details className="border-t border-slate-100 pt-3">
              <summary className="cursor-pointer text-xs text-slate-500">历史对话</summary>
              <div className="mt-2 grid max-h-48 gap-1 overflow-auto">
                {histories.map((room) => (
                  <button
                    key={room.id}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => {
                      setOpen(false);
                      onSelectConversation(room.id);
                    }}
                  >
                    <History size={14} />
                    <span className="truncate">{room.name}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
          <ChiefHistorySearch
            query={query}
            workspaceId={workspaceId}
            data={data}
            mutate={mutate}
            onContinue={() => {
              setOpen(false);
              onSelectConversation(chief.homeConversationId);
            }}
          />
        </div>
      </Modal>
    </div>
  );
}
