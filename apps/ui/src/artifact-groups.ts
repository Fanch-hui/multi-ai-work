import type { Artifact, Bot, Conversation, Snapshot, Task } from '../../../src/domain/types.js';
import { isDeliverableArtifact } from '../../../src/domain/artifact-purpose.js';

export interface ArtifactGroup {
  id: string;
  title: string;
  updatedAt: string;
  artifacts: Artifact[];
}

interface GroupOrigin { id: string; title: string; }

function groupOrigin(artifact: Artifact, tasks: Map<string, Task>, conversations: Map<string, Conversation>): GroupOrigin {
  let task = artifact.taskId ? tasks.get(artifact.taskId) : undefined;
  let conversationId = task?.conversationId ?? artifact.conversationId;
  let room = conversations.get(conversationId);
  const originalRoom = room;
  const visited = new Set<string>();
  while (!visited.has(`${conversationId}:${task?.id ?? ''}`)) {
    visited.add(`${conversationId}:${task?.id ?? ''}`);
    const source = room?.sourceTaskId ? tasks.get(room.sourceTaskId) : undefined;
    if (room?.kind === 'group' && room.purpose === 'task' && room.sourceConversationId
      && (!source || source.conversationId === room.sourceConversationId)) {
      conversationId = room.sourceConversationId;
      task = source;
      room = conversations.get(conversationId);
      continue;
    }
    if (room) break;
    const parent = task?.parentId ? tasks.get(task.parentId) : undefined;
    if (!parent) break;
    task = parent;
    conversationId = task.conversationId;
    room = conversations.get(conversationId);
  }
  return { id: `conversation:${conversationId}`, title: room?.name || originalRoom?.name
    || task?.goal.trim().replace(/\s+/g, ' ') || '已删除对话的成果' };
}

export function artifactProducer(artifact: Artifact, tasks: Map<string, Task>, bots: Map<string, Bot>): Bot | undefined {
  const botId = artifact.botId ?? (artifact.taskId ? tasks.get(artifact.taskId)?.botId : undefined);
  return botId ? bots.get(botId) : undefined;
}

export function artifactGroups(data: Pick<Snapshot, 'artifacts' | 'tasks' | 'conversations'>, query = ''): ArtifactGroup[] {
  const tasks = new Map(data.tasks.map(task => [task.id, task]));
  const conversations = new Map(data.conversations.map(room => [room.id, room]));
  const groups = new Map<string, ArtifactGroup>();
  const current = new Map<string, Artifact>();
  for (const artifact of data.artifacts) {
    if (!isDeliverableArtifact(artifact)) continue;
    const task = artifact.taskId ? tasks.get(artifact.taskId) : undefined;
    const key = JSON.stringify([artifact.taskId ?? null, artifact.taskId ? null : artifact.conversationId,
      artifact.botId ?? task?.botId ?? null,
      artifact.workingPath || artifact.id]);
    const previous = current.get(key);
    if (!previous || artifact.createdAt > previous.createdAt) current.set(key, artifact);
  }
  const search = query.toLocaleLowerCase();
  for (const artifact of current.values()) {
    if (!artifact.name.toLocaleLowerCase().includes(search)) continue;
    const { id, title } = groupOrigin(artifact, tasks, conversations);
    let group = groups.get(id);
    if (!group) {
      group = { id, title, updatedAt: artifact.createdAt, artifacts: [] };
      groups.set(id, group);
    }
    group.artifacts.push(artifact);
    if (artifact.createdAt > group.updatedAt) group.updatedAt = artifact.createdAt;
  }
  for (const group of groups.values()) group.artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
