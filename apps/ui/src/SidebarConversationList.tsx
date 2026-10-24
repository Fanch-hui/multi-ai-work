import { useState } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import { activeTask, cn } from './components.js';
import { ConversationAvatar } from './ConversationAvatar.js';

type ListProps = {
  data?: Snapshot;
  archived: boolean;
  query: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onManage: (id: string) => void;
};

export function SidebarConversationList(props: ListProps) {
  const { data, archived, query } = props;
  const conversations = (data?.conversations ?? [])
    .map((item) =>
      item.id === data?.chief?.homeConversationId
        ? { ...item, name: data.bots.find((bot) => bot.id === item.chiefId)?.name ?? item.name }
        : item,
    )
    .filter(
      (item) =>
        !!item.archived === archived &&
        item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .slice()
    .reverse();
  const sections = [
    {
      id: 'chief',
      label: archived ? '已归档主对话' : '管家',
      items: conversations.filter(
        (item) =>
          item.purpose === 'chief' && (!data?.chief || item.id === data.chief.homeConversationId),
      ),
    },
    {
      id: 'history',
      label: '历史',
      items: (data?.conversations ?? []).filter(
        (item) =>
          item.chiefRole === 'history' &&
          item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    },
    {
      id: 'groups',
      label: '任务群聊',
      items: conversations.filter((item) => item.purpose !== 'chief' && item.kind === 'group'),
    },
    {
      id: 'private',
      label: '成员对话',
      items: conversations.filter((item) => item.purpose !== 'chief' && item.kind === 'private'),
    },
  ];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2" aria-label="会话列表">
      {sections
        .filter((section) => !['private', 'history'].includes(section.id) || section.items.length)
        .map((section) => (
          <ConversationSection
            key={section.id}
            label={section.label}
            items={section.items}
            initiallyCollapsed={section.id === 'history'}
            {...props}
          />
        ))}
      {query && !conversations.length && (
        <p className="px-3 py-4 text-xs text-slate-500">没有匹配的对话</p>
      )}
    </div>
  );
}

function ConversationSection({
  label,
  items,
  initiallyCollapsed,
  ...props
}: ListProps & { label: string; items: Conversation[]; initiallyCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(!!initiallyCollapsed);
  const [expanded, setExpanded] = useState(false);
  const visibleItems = props.query || expanded ? items : items.slice(0, 5);
  const selectedItem = items.find((item) => item.id === props.selectedId);
  const shownItems =
    !props.query && !expanded && selectedItem && !visibleItems.includes(selectedItem)
      ? [...visibleItems.slice(0, 4), selectedItem]
      : visibleItems;
  const unread = items.reduce((count, item) => count + (item.unreadCount || 0), 0);
  return (
    <details
      open={!!props.query || !collapsed}
      className="sidebar-conversation-section mb-2"
      onToggle={(event) => {
        if (!props.query) setCollapsed(!event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-1 text-xs text-slate-500 hover:bg-black/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex size-5 shrink-0 items-center justify-center">
          <ChevronRight size={12} aria-hidden="true" className="sidebar-section-chevron" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!!unread && (
          <span className="shrink-0 tabular-nums text-blue-600" aria-label={`${unread} 条未读消息`}>
            {unread > 99 ? '99+' : unread} 未读
          </span>
        )}
        <span
          className="shrink-0 tabular-nums text-slate-400"
          aria-label={`${items.length} 个会话`}
        >
          {items.length}
        </span>
      </summary>
      {shownItems.map((item) => (
        <ConversationRow key={item.id} item={item} {...props} />
      ))}
      {!props.query && items.length > 5 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="min-h-7 w-full rounded-lg py-1 pl-10 pr-3 text-left text-xs text-slate-400 hover:bg-black/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {expanded ? '收起显示' : '展开显示'}
        </button>
      )}
    </details>
  );
}

function ConversationRow({
  item,
  data,
  selectedId,
  onSelect,
  onManage,
}: ListProps & { item: Conversation }) {
  const selected = selectedId === item.id;
  return (
    <div className="group relative mb-0.5 flex items-center">
      <button
        onClick={() => onSelect(item.id)}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'sidebar-row flex min-h-8 w-full items-center gap-2 rounded-lg py-1 pl-3 pr-8 text-left text-sm leading-5',
          selected ? 'bg-black/6 text-slate-950' : 'text-slate-600 hover:bg-black/4',
        )}
      >
        <ConversationAvatar
          conversation={item}
          bots={data?.bots || []}
          className="size-5 rounded-md"
        />
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        {!!item.unreadCount && (
          <span
            aria-label={`${item.unreadCount} 条未读消息`}
            className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-medium tabular-nums text-white"
          >
            {item.unreadCount > 99 ? '99+' : item.unreadCount}
          </span>
        )}
        {data?.tasks.some(
          (task) =>
            task.kind !== 'memory-review' &&
            task.conversationId === item.id &&
            activeTask(task.status),
        ) && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-blue-500"
            aria-label="有进行中的任务"
          />
        )}
      </button>
      <button
        aria-label={`管理会话 ${item.name}`}
        title="管理会话"
        onClick={() => onManage(item.id)}
        className="absolute right-1 rounded-md p-1 text-slate-400 opacity-0 hover:bg-black/5 focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}
