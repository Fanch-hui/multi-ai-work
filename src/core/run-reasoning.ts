import type { Bot, Connection, Conversation } from '../domain/types.js';
import type { State } from './state.js';

/** Read a setting at a request boundary without changing the run's identity or authorization. */
export function runReasoningEffort(
  state: State,
  bot: Bot,
  room: Conversation,
  connection: Connection,
): string | undefined {
  const currentBot = state.storage.get<Bot>('bots', bot.id);
  const currentRoom = state.storage.get<Conversation>('conversations', room.id);
  const currentConnection = state.storage.get<Connection>('connections', connection.id);
  if (
    !currentBot ||
    !currentRoom ||
    currentBot.connectionId !== connection.id ||
    currentConnection?.revision !== connection.revision
  )
    return bot.reasoning;
  const chief = currentRoom.chiefId === bot.id && !!currentRoom.model;
  const model = chief ? currentRoom.model : currentBot.model;
  if (model !== bot.model) return bot.reasoning;
  return chief ? currentRoom.reasoning : currentBot.reasoning;
}
