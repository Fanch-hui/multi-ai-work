import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { State } from './state.js';

export function scopedTask(state: State, room: Conversation, botId: string, taskId: string): Task | undefined {
  const s = state.storage, task = s.get<Task>('tasks', taskId);
  if (!task) return undefined;
  if (task.conversationId === room.id) return task;
  const group = s.get<Conversation>('conversations', task.conversationId);
  const source = group?.sourceTaskId ? s.get<Task>('tasks', group.sourceTaskId) : undefined;
  return botId === state.settings().mainBotId && room.purpose === 'chief' && group?.purpose === 'task'
    && group.sourceConversationId === room.id && source?.conversationId === room.id && source.botId === botId ? task : undefined;
}

export function returnTaskArtifacts(state: State, room: Conversation, botId: string, task: Task, artifactIds: string[]) {
  const s = state.storage;
  const group = s.get<Conversation>('conversations', task.conversationId);
  if (botId !== state.settings().mainBotId || room.purpose !== 'chief' || group?.sourceConversationId !== room.id || !group.sourceTaskId) return;
  const source = s.get<Task>('tasks', group.sourceTaskId);
  if (!source || source.conversationId !== room.id || source.botId !== botId) return;
  const valid = artifactIds.filter(artifactId => s.get<Artifact>('artifacts', artifactId)?.conversationId === group.id);
  const key = `returned-artifacts:${source.id}`;
  s.setMetadata(key, [...new Set([...s.metadata<string[]>(key) ?? [], ...valid])]);
}
