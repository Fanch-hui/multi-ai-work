import type { ChiefWorkContext } from '../domain/chief-work.js';
import type { Conversation, Settings } from '../domain/types.js';
import type { Storage } from './storage.js';

export function memoryConversationId(storage: Storage, botId: string, conversationId: string) {
  const settings = storage.metadata<Settings>('settings');
  if (botId !== settings?.mainBotId) return conversationId;
  const room = storage.get<Conversation>('conversations', conversationId);
  if (
    room?.chiefRole !== 'main' ||
    room.kind !== 'private' ||
    room.purpose !== 'chief' ||
    room.chiefId !== botId ||
    room.chiefHomeId !== settings.mainConversationId
  )
    return conversationId;
  const context = room.chiefContextId
    ? storage.get<ChiefWorkContext>('chief_contexts', room.chiefContextId)
    : undefined;
  return context?.kind === 'main' && context.homeConversationId === settings.mainConversationId
    ? context.homeConversationId
    : conversationId;
}

export function memoryMessageAuthorized(
  storage: Storage,
  messageId: string,
  conversationIds: string[],
) {
  const message = storage.getMessage(messageId);
  if (!message) return false;
  if (conversationIds.includes(message.conversationId)) return true;
  const chiefId = storage.metadata<Settings>('settings')?.mainBotId;
  if (!chiefId) return false;
  const source = memoryConversationId(storage, chiefId, message.conversationId);
  return conversationIds.some((id) => memoryConversationId(storage, chiefId, id) === source);
}
