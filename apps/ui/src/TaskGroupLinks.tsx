import { ArrowUpRight } from 'lucide-react';
import type { Bot, Conversation } from '../../../src/domain/types.js';
import { ConversationAvatar } from './ConversationAvatar.js';

export function TaskGroupLinks({
  groups,
  bots,
  onSelect,
}: {
  groups: Conversation[];
  bots: Bot[];
  onSelect: (id: string) => void;
}) {
  if (!groups.length) return null;
  return (
    <div className="-mt-5 ml-11 grid min-w-0 gap-1" aria-label="关联任务群聊">
      {groups.map((group) => (
        <button
          key={group.id}
          data-task-group-id={group.id}
          onClick={() => onSelect(group.id)}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"
        >
          <ConversationAvatar conversation={group} bots={bots} className="size-6" />
          <span className="truncate">{group.name}</span>
          <span className="ml-auto shrink-0 text-slate-400">进入群聊</span>
          <ArrowUpRight size={13} className="shrink-0" />
        </button>
      ))}
    </div>
  );
}
