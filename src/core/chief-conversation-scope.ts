import type { ChiefContextPart, ChiefWorkContext } from '../domain/chief-work.js';
import type { Conversation } from '../domain/types.js';
import type { State } from './state.js';

export function chiefConversationScope(state: State, room: Conversation): Set<string> {
  const ids = new Set([room.id]);
  const settings = state.settings();
  if (
    room.purpose !== 'chief' ||
    room.kind !== 'private' ||
    room.chiefId !== settings.mainBotId ||
    (room.id !== settings.mainConversationId && room.chiefRole !== 'main')
  )
    return ids;
  const s = state.storage;
  ids.add(settings.mainConversationId!);
  const contexts = s.byField<ChiefWorkContext>(
    'chief_contexts',
    'homeConversationId',
    settings.mainConversationId!,
  );
  for (const context of contexts) {
    for (const part of s.byField<ChiefContextPart>('chief_parts', 'contextId', context.id))
      ids.add(part.conversationId);
  }
  const groups = s
    .all<Conversation>('conversations')
    .filter((item) => item.kind === 'group' && item.chiefId === settings.mainBotId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!ids.has(group.id) && group.sourceConversationId && ids.has(group.sourceConversationId)) {
        ids.add(group.id);
        changed = true;
      }
    }
  }
  return ids;
}
