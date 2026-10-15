import type { Artifact, Conversation, Run, Task } from '../domain/types.js';
import type { State } from './state.js';

export function accessibleArtifacts(state: State, room: Conversation, botId: string, task?: Task): Artifact[] {
  const s = state.storage;
  const returned = new Set<string>();
  if (room.purpose === 'chief' && botId === state.settings().mainBotId) {
    for (const task of s.all<Task>('tasks').filter(item => item.conversationId === room.id)) {
      for (const artifactId of s.metadata<string[]>(`returned-artifacts:${task.id}`) ?? []) {
        const artifact = s.get<Artifact>('artifacts', artifactId);
        const group = artifact && s.get<Conversation>('conversations', artifact.conversationId);
        if (group?.sourceConversationId === room.id && group.sourceTaskId === task.id) returned.add(artifactId);
      }
      for (const result of s.metadata<{ taskId: string; artifactIds: string[] }[]>(`results:${task.id}`) ?? []) {
        const child = s.get<Task>('tasks', result.taskId);
        const group = child && s.get<Conversation>('conversations', child.conversationId);
        if (child?.parentId !== task.id || group?.sourceConversationId !== room.id || group.sourceTaskId !== task.id) continue;
        for (const artifactId of result.artifactIds) returned.add(artifactId);
      }
    }
  }
  if (task?.botId === botId && task.conversationId === room.id && task.parentId) {
    const parent = s.get<Task>('tasks', task.parentId);
    const isBound = parent && (parent.conversationId === room.id
      || room.sourceTaskId === parent.id && room.sourceConversationId === parent.conversationId);
    const parentRoom = parent && s.get<Conversation>('conversations', parent.conversationId);
    if (isBound && parentRoom) {
      const inherited = new Set(accessibleArtifacts(state, parentRoom, parent!.botId, parent).map(item => item.id));
      for (const artifactId of task.inputArtifactIds ?? []) if (inherited.has(artifactId)) returned.add(artifactId);
    }
  }
  return s.all<Artifact>('artifacts').filter(item => item.conversationId === room.id || returned.has(item.id));
}

export function ownsTaskFile(state: State, task: Task, path: string, version: string): boolean {
  const s = state.storage;
  if (s.all<Artifact>('artifacts').some(item => item.taskId === task.id && item.workingPath === path && item.sha256 === version)) return true;
  return s.all<{ runId: string; name: string; status: string; result?: { path?: string; version?: string } }>('tool_operations')
    .some(item => s.get<Run>('runs', item.runId)?.taskId === task.id && ['write_file', 'edit_file'].includes(item.name)
      && item.status === 'succeeded' && item.result?.path === path && item.result.version === version);
}

export function messageTools(state: State, roomId: string) {
  const messages = () => state.storage.messages(roomId).filter(item => item.status === 'committed');
  return {
    readMessages: (after = 0, limit = 30, around?: number) => {
      const all = messages();
      if (around === undefined) return all.filter(item => item.sequence > after).slice(0, Math.min(limit, 100));
      const index = all.findIndex(item => item.sequence >= around);
      return all.slice(Math.max(0, index - Math.floor(limit / 2)), Math.max(0, index - Math.floor(limit / 2)) + Math.min(limit, 100));
    },
    searchMessages: (query: string, limit = 20) => {
      const needle = query.toLocaleLowerCase();
      return messages().filter(item => item.content.toLocaleLowerCase().includes(needle)).slice(-Math.min(limit, 100)).map(item => {
        const offset = item.content.toLocaleLowerCase().indexOf(needle);
        return { messageId: item.id, sequence: item.sequence, authorType: item.authorType, authorBotId: item.authorBotId,
          createdAt: item.createdAt, excerpt: item.content.slice(Math.max(0, offset - 100), offset + query.length + 200) };
      });
    },
  };
}
