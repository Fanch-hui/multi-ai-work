import { ArrowLeft, MoreHorizontal, PanelLeft, Users, Globe, Inbox } from 'lucide-react';
import type { Bot, Conversation } from '../../../src/domain/types.js';
import { Button, cn } from './components.js';
import { ConversationAvatar } from './ConversationAvatar.js';

export type ChatView = 'chat' | 'records';
interface Props {
  conversation: Conversation;
  bots: Bot[];
  view: ChatView;
  pending: number;
  working: number;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onSelectConversation: (id: string) => void;
  onViewChange: (view: ChatView) => void;
  onManage: () => void;
  onMembers: () => void;
  onBrowser: () => void;
  onPending: () => void;
  pendingWork: number;
}

export function ChatHeader({
  conversation,
  bots,
  view,
  pending,
  working,
  sidebarCollapsed,
  onExpandSidebar,
  onSelectConversation,
  onViewChange,
  onManage,
  onMembers,
  onBrowser,
  onPending,
  pendingWork,
}: Props) {
  const main = conversation.purpose === 'chief';
  const tabClass = 'border-b-2 py-1.5 text-xs';
  const selectedClass = 'border-blue-500 text-blue-600';
  const idleClass = 'border-transparent text-slate-400 hover:text-slate-600';
  return (
    <div
      className={cn(
        'app-titlebar flex min-h-12 items-center gap-4 px-5 max-sm:gap-2 max-sm:px-3',
        sidebarCollapsed && 'app-titlebar-collapsed',
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {sidebarCollapsed && (
          <Button
            variant="ghost"
            className="size-8 min-h-8 shrink-0 p-0"
            aria-label="展开侧边栏"
            onClick={onExpandSidebar}
          >
            <PanelLeft size={17} />
          </Button>
        )}
        {!main && conversation.sourceConversationId && (
          <Button
            variant="ghost"
            className="size-8 min-h-8 shrink-0 p-0"
            aria-label="返回来源主对话"
            title="返回主对话"
            onClick={() => onSelectConversation(conversation.sourceConversationId!)}
          >
            <ArrowLeft size={17} />
          </Button>
        )}
        <ConversationAvatar conversation={conversation} bots={bots} className="size-7" />
        <h1 className="truncate text-sm font-medium text-slate-800" title={conversation.name}>
          {conversation.name}
        </h1>
        {!main && conversation.kind === 'group' && (
          <button
            onClick={onMembers}
            aria-label="查看和管理群聊成员"
            title={`${conversation.memberIds.length} 位智能体`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-50 hover:text-slate-700"
          >
            <Users size={13} />
            {conversation.memberIds.length}
          </button>
        )}
      </div>
      <nav className="flex shrink-0 items-center gap-4" aria-label="会话视图">
        <button
          className={cn(tabClass, view === 'chat' ? selectedClass : idleClass)}
          aria-pressed={view === 'chat'}
          onClick={() => onViewChange('chat')}
        >
          对话
        </button>
        <button
          className={cn(
            'flex items-center gap-1.5',
            tabClass,
            view === 'records' ? selectedClass : idleClass,
          )}
          aria-pressed={view === 'records'}
          onClick={() => onViewChange('records')}
        >
          记录
          {pending > 0 ? (
            <span className="rounded bg-amber-100 px-1.5 text-xs tabular-nums text-amber-800">
              {pending} 待批准
            </span>
          ) : (
            working > 0 && (
              <span className="rounded bg-blue-50 px-1.5 text-xs tabular-nums text-blue-600">
                {working} 进行中
              </span>
            )
          )}
        </button>
      </nav>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          className="min-h-8 gap-1 px-2 text-xs"
          aria-label="待我处理"
          title="待我处理"
          onClick={onPending}
        >
          <Inbox size={16} />
          {pendingWork > 0 && <span className="tabular-nums">{pendingWork}</span>}
        </Button>
        <Button
          variant="ghost"
          className="size-8 min-h-8 p-0"
          aria-label="工作浏览器"
          title="工作浏览器"
          onClick={onBrowser}
        >
          <Globe size={16} />
        </Button>
        <Button
          variant="ghost"
          className="size-8 min-h-8 p-0"
          aria-label="管理当前会话"
          title="管理会话"
          onClick={onManage}
        >
          <MoreHorizontal size={17} />
        </Button>
      </div>
    </div>
  );
}
