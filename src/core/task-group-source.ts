import type { ChiefWorkContext } from '../domain/chief-work.js';
import type { Conversation, Message, Task } from '../domain/types.js';
import type { Storage } from './storage.js';

/** Resolves a creation anchor once; later replies never move an existing group entry. */
export function taskGroupSourceMessage(
  storage: Storage,
  source: Task,
  runId?: string,
): string | undefined {
  const room = storage.get<Conversation>('conversations', source.conversationId);
  const visible = (message: Message) => {
    const owner = storage.get<Conversation>('conversations', message.conversationId);
    return (
      owner?.purpose === 'chief' &&
      owner.kind === 'private' &&
      !['work', 'routine', 'router'].includes(owner.chiefRole ?? '') &&
      message.authorType !== 'system' &&
      (!!message.content.trim() || !!message.artifactIds.length)
    );
  };
  if (runId && source.runIds.includes(runId)) {
    const reply = storage
      .messages(source.conversationId)
      .filter(
        (message) =>
          message.runId === runId &&
          message.authorType === 'bot' &&
          message.authorBotId === source.botId &&
          visible(message),
      )
      .at(-1);
    if (reply) return reply.id;
  }

  const visited = new Set<string>();
  const fromTask = (task: Task): string | undefined => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const message = task.sourceMessageId ? storage.getMessage(task.sourceMessageId) : undefined;
    if (message && visible(message)) return message.id;
    const origin = message
      ? storage.metadata<{ sourceTaskId?: string; sourceMessageIds?: string[] }>(
          `chief-work-source:${message.id}`,
        )
      : undefined;
    const owner = storage.get<Conversation>('conversations', task.conversationId);
    const work = owner?.chiefContextId
      ? storage.get<ChiefWorkContext>('chief_contexts', owner.chiefContextId)
      : undefined;
    const sources = (origin?.sourceMessageIds ?? work?.sourceMessageIds ?? [])
      .map((id) => storage.getMessage(id))
      .filter((item): item is Message => !!item && item.authorType === 'user' && visible(item))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence);
    if (sources.length) return sources.at(-1)!.id;
    const parentId = origin?.sourceTaskId ?? work?.sourceTaskId ?? task.parentId;
    const parent = parentId ? storage.get<Task>('tasks', parentId) : undefined;
    return parent ? fromTask(parent) : undefined;
  };
  return room ? fromTask(source) : undefined;
}

export function withTaskGroupSource(storage: Storage, room: Conversation): Conversation {
  if (room.purpose !== 'task' || room.sourceMessageId || !room.sourceTaskId) return room;
  const source = storage.get<Task>('tasks', room.sourceTaskId);
  const sourceMessageId = source && taskGroupSourceMessage(storage, source);
  return sourceMessageId ? { ...room, sourceMessageId } : room;
}
