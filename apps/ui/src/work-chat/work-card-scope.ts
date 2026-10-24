import type { Snapshot } from '../../../../src/domain/types.js';
import { chiefConversationIds, isChiefHome } from '../chief-work.js';
import { conversationRecordTasks } from '../conversation-records.js';

export function workCardConversationIds(data: Snapshot, conversationId: string): Set<string> {
  const room = data.conversations.find((item) => item.id === conversationId);
  if (!room || !isChiefHome(data, room)) return new Set([conversationId]);
  return new Set([
    ...chiefConversationIds(data, room),
    ...conversationRecordTasks(data, room).map((task) => task.conversationId),
  ]);
}

export function conversationWorkItems<T extends { conversationId: string }>(
  items: T[],
  conversationIds: ReadonlySet<string>,
): T[] {
  return items.filter((item) => conversationIds.has(item.conversationId));
}
