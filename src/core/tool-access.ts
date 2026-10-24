import type { Artifact, Conversation, Run, Task } from '../domain/types.js';
import type { State } from './state.js';

export function accessibleArtifacts(
  state: State,
  room: Conversation,
  botId: string,
  task?: Task,
): Artifact[] {
  const s = state.storage;
  const returned = new Set<string>();
  if (room.purpose === 'chief' && room.kind === 'private' && botId === state.settings().mainBotId)
    for (const artifactId of s.metadata<string[]>(`chief-artifact-grants:${room.id}`) ?? [])
      returned.add(artifactId);
  if (room.kind === 'group' && room.memberIds.includes(botId)) {
    for (const message of s.messages(room.id).filter((item) => item.status === 'committed'))
      for (const artifactId of message.artifactIds) returned.add(artifactId);
  }
  if (room.purpose === 'chief' && botId === state.settings().mainBotId) {
    for (const task of s.byField<Task>('tasks', 'conversationId', room.id)) {
      for (const artifactId of s.metadata<string[]>(`returned-artifacts:${task.id}`) ?? []) {
        const artifact = s.get<Artifact>('artifacts', artifactId);
        const group = artifact && s.get<Conversation>('conversations', artifact.conversationId);
        if (group?.sourceConversationId === room.id && group.sourceTaskId === task.id)
          returned.add(artifactId);
      }
      for (const result of s.metadata<{ taskId: string; artifactIds: string[] }[]>(
        `results:${task.id}`,
      ) ?? []) {
        const child = s.get<Task>('tasks', result.taskId);
        const group = child && s.get<Conversation>('conversations', child.conversationId);
        if (
          child?.parentId !== task.id ||
          group?.sourceConversationId !== room.id ||
          group.sourceTaskId !== task.id
        )
          continue;
        for (const artifactId of result.artifactIds) returned.add(artifactId);
      }
    }
  }
  if (task?.botId === botId && task.conversationId === room.id && task.parentId) {
    const parent = s.get<Task>('tasks', task.parentId);
    const isBound =
      parent &&
      (parent.conversationId === room.id ||
        (room.sourceTaskId === parent.id && room.sourceConversationId === parent.conversationId));
    const parentRoom = parent && s.get<Conversation>('conversations', parent.conversationId);
    if (isBound && parentRoom) {
      const inherited = new Set(
        accessibleArtifacts(state, parentRoom, parent!.botId, parent).map((item) => item.id),
      );
      for (const artifactId of task.inputArtifactIds ?? [])
        if (inherited.has(artifactId)) returned.add(artifactId);
    }
  }
  const artifacts = s.byField<Artifact>('artifacts', 'conversationId', room.id);
  const seen = new Set(artifacts.map((item) => item.id));
  for (const id of returned) {
    if (seen.has(id)) continue;
    const artifact = s.get<Artifact>('artifacts', id);
    if (artifact) {
      seen.add(id);
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

export function ownsTaskFile(state: State, task: Task, path: string, version: string): boolean {
  const s = state.storage;
  if (
    s
      .byField<Artifact>('artifacts', 'taskId', task.id)
      .some((item) => item.workingPath === path && item.sha256 === version)
  )
    return true;
  const runIds = new Set([
    ...task.runIds,
    ...(s.get<Task>('tasks', task.id)?.runIds ?? []),
    ...s.byField<Run>('runs', 'taskId', task.id).map((run) => run.id),
  ]);
  for (const runId of runIds) {
    const matched = s
      .byField<{
        runId: string;
        name: string;
        status: string;
        result?: { path?: string; version?: string };
      }>('tool_operations', 'runId', runId)
      .some(
        (item) =>
          ['write_file', 'edit_file'].includes(item.name) &&
          item.status === 'succeeded' &&
          item.result?.path === path &&
          item.result.version === version,
      );
    if (matched) return true;
  }
  return false;
}

export function messageTools(state: State, roomId: string) {
  const messages = () =>
    state.storage.messages(roomId).filter((item) => item.status === 'committed');
  return {
    readMessages: (after = 0, limit = 30, around?: number) => {
      const all = messages();
      if (around === undefined)
        return all.filter((item) => item.sequence > after).slice(0, Math.min(limit, 100));
      const index = all.findIndex((item) => item.sequence >= around);
      return all.slice(
        Math.max(0, index - Math.floor(limit / 2)),
        Math.max(0, index - Math.floor(limit / 2)) + Math.min(limit, 100),
      );
    },
    searchMessages: (query: string, limit = 20) => {
      const needle = query.toLocaleLowerCase();
      return messages()
        .filter((item) => item.content.toLocaleLowerCase().includes(needle))
        .slice(-Math.min(limit, 100))
        .map((item) => {
          const offset = item.content.toLocaleLowerCase().indexOf(needle);
          return {
            messageId: item.id,
            sequence: item.sequence,
            authorType: item.authorType,
            authorBotId: item.authorBotId,
            createdAt: item.createdAt,
            excerpt: item.content.slice(Math.max(0, offset - 100), offset + query.length + 200),
          };
        });
    },
  };
}
