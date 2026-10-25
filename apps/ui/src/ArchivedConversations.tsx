import { useState } from 'react';
import { MoreHorizontal, Search } from 'lucide-react';
import type { Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { ConversationAvatar } from './ConversationAvatar.js';
import { ConversationActions } from './ConversationActions.js';
import { ModalPresence } from './ModalPresence.js';

export function ArchivedConversations({
  data,
  mutate,
  onSelectConversation,
}: {
  data: Snapshot;
  mutate: Mutate;
  onSelectConversation?: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [manageId, setManageId] = useState('');
  const conversations = data.conversations
    .filter(
      (item) =>
        item.archived &&
        !item.timelineOnly &&
        item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .slice()
    .reverse();
  const managed = data.conversations.find((item) => item.id === manageId);
  return (
    <section className="grid gap-4" aria-label="已归档会话">
      <div className="relative max-w-sm">
        <Search size={15} aria-hidden="true" className="absolute left-3 top-3 text-slate-400" />
        <input
          aria-label="搜索已归档会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索已归档会话"
          className="min-h-10 w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div className="grid gap-1">
        {conversations.map((item) => {
          const getConversationLabel = () => {
            if (item.purpose === 'chief') {
              return '主对话';
            }
            if (item.kind === 'group') {
              return '群聊';
            }
            return '成员对话';
          };
          return (
            <div key={item.id} className="flex min-w-0 items-center rounded-lg hover:bg-slate-50">
              <button
                onClick={() => onSelectConversation?.(item.id)}
                disabled={!onSelectConversation}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <ConversationAvatar
                  conversation={item}
                  bots={data.bots}
                  className="size-6 rounded-md"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{item.name}</span>
                <span className="shrink-0 text-xs text-slate-400">{getConversationLabel()}</span>
              </button>
              <button
                onClick={() => setManageId(item.id)}
                aria-label={`管理归档会话 ${item.name}`}
                className="mr-2 rounded-md p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          );
        })}
        {!conversations.length && (
          <p className="py-6 text-sm text-slate-500">
            {query ? '没有匹配的已归档会话' : '暂无已归档会话'}
          </p>
        )}
      </div>
      <ModalPresence show={!!managed}>
        {managed && (
          <ConversationActions
            conversation={managed}
            mutate={mutate}
            close={() => setManageId('')}
          />
        )}
      </ModalPresence>
    </section>
  );
}
