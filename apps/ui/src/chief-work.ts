import type { Conversation, Message, Snapshot, Task } from '../../../src/domain/types.js';

type ChiefData = Partial<Pick<Snapshot, 'chief'>>;

export const messageOrder = (message: Message) => message.chiefTimelineSequence ?? message.sequence;

export function isChiefHome(data: ChiefData, conversation: Conversation): boolean {
  return data.chief?.homeConversationId === conversation.id || conversation.chiefRole === 'home';
}

export function focusedChiefContext(data: ChiefData) {
  return data.chief?.contexts.find((context) => context.id === data.chief?.focusContextId);
}

export function chiefConversationIds(data: ChiefData, conversation: Conversation): Set<string> {
  if (!isChiefHome(data, conversation)) return new Set([conversation.id]);
  return new Set([
    conversation.id,
    ...(data.chief?.contexts.flatMap((context) => context.conversationIds) ?? []),
  ]);
}

export function focusedConversation(
  data: Pick<Snapshot, 'conversations'> & ChiefData,
  room: Conversation,
) {
  if (!isChiefHome(data, room)) return room;
  const context = focusedChiefContext(data);
  return data.conversations.find((item) => item.id === context?.conversationId) ?? room;
}

export function isChiefHistory(data: ChiefData, conversation: Conversation): boolean {
  return (
    conversation.purpose === 'chief' &&
    !isChiefHome(data, conversation) &&
    (conversation.chiefRole === 'history' || (!conversation.chiefRole && !!data.chief))
  );
}

export function contextRecordTasks(tasks: Task[], conversationIds: string[]): Task[] {
  const rooms = new Set(conversationIds);
  const selected = new Set(
    tasks.filter((task) => rooms.has(task.conversationId)).map((task) => task.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (selected.has(task.id) || !task.parentId || !selected.has(task.parentId)) continue;
      selected.add(task.id);
      changed = true;
    }
  }
  return tasks.filter((task) => selected.has(task.id));
}

export function chiefTaskContext(data: Pick<Snapshot, 'tasks'> & ChiefData, taskId: string) {
  const visited = new Set<string>();
  let task = data.tasks.find((item) => item.id === taskId);
  while (task && !visited.has(task.id)) {
    visited.add(task.id);
    const conversationId = task.conversationId;
    const context = data.chief?.contexts.find((item) =>
      item.conversationIds.includes(conversationId),
    );
    if (context) return context;
    task = task.parentId ? data.tasks.find((item) => item.id === task?.parentId) : undefined;
  }
  return undefined;
}
