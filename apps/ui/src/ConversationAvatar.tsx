import type { Bot, Conversation } from '../../../src/domain/types.js';
import Avatar from './Avatar.js';
import { cn } from './classNames.js';

export function ConversationAvatar({
  conversation,
  bots,
  className,
}: {
  conversation: Conversation;
  bots: Bot[];
  className?: string;
}) {
  const members = conversation.memberIds
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot): bot is Bot => !!bot);
  if (conversation.kind !== 'group' || members.length < 2) {
    const bot = members.find((bot) => bot.id === conversation.chiefId) ?? members[0];
    return <Avatar bot={bot} name={bot?.name ?? conversation.name} className={className} />;
  }
  return (
    <span className={cn('relative size-8 shrink-0', className)}>
      {members.slice(0, 2).map((bot, index) => (
        <Avatar
          key={bot.id}
          bot={bot}
          className={cn(
            'absolute size-2/3 rounded-md ring-1 ring-white',
            index === 0 ? 'left-0 top-0' : 'bottom-0 right-0',
          )}
        />
      ))}
    </span>
  );
}
