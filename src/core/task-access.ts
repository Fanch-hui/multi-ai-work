import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { ChiefContextPart, ChiefWorkContext } from '../domain/chief-work.js';
import type { State } from './state.js';
import type { Routine, RoutineOccurrence } from '../domain/routines.js';

function chiefOwnsTask(state: State, room: Conversation, botId: string, task: Task): boolean {
  if (
    botId !== state.settings().mainBotId ||
    room.purpose !== 'chief' ||
    room.kind !== 'private' ||
    task.botId !== botId
  )
    return false;
  if (task.conversationId === room.id) return true;
  const s = state.storage;
  const source = s.get<Conversation>('conversations', task.conversationId);
  if (source?.purpose !== 'chief' || source.kind !== 'private' || source.chiefId !== botId)
    return false;
  if (room.chiefRole === 'main' && source.chiefHomeId === room.chiefHomeId) {
    const owned = s.firstByField<ChiefContextPart>('chief_parts', 'conversationId', source.id);
    const work = owned && s.get<ChiefWorkContext>('chief_contexts', owned.contextId);
    if (work?.kind === 'work' && work.homeConversationId === room.chiefHomeId) return true;
  }
  if ((s.metadata<string[]>(`chief-task-grants:${room.id}`) ?? []).includes(task.id)) return true;
  const part = s.firstByField<ChiefContextPart>('chief_parts', 'conversationId', room.id);
  const context = part && s.get<ChiefWorkContext>('chief_contexts', part.contextId);
  if (!context || context.homeConversationId !== state.settings().mainConversationId) return false;
  if (context.legacyTaskId === task.id && context.legacyConversationId === task.conversationId)
    return true;
  const sourcePart = s.firstByField<ChiefContextPart>(
    'chief_parts',
    'conversationId',
    task.conversationId,
  );
  return sourcePart?.contextId === context.id;
}

function chiefOwnsRoutineTask(state: State, room: Conversation, botId: string, task: Task) {
  if (
    botId !== state.settings().mainBotId ||
    room.chiefRole !== 'main' ||
    room.chiefHomeId !== state.settings().mainConversationId ||
    task.trigger?.type !== 'routine'
  )
    return false;
  const s = state.storage;
  const routine = s.get<Routine>('routines', task.trigger.routineId);
  const occurrence = s.get<RoutineOccurrence>('routine_occurrences', task.trigger.occurrenceId);
  return (
    routine &&
    occurrence &&
    occurrence.taskId === task.id &&
    occurrence.routineId === routine.id &&
    task.botId === routine.botId &&
    task.conversationId === routine.conversationId
  );
}

export function scopedTask(
  state: State,
  room: Conversation,
  botId: string,
  taskId: string,
): Task | undefined {
  const s = state.storage,
    task = s.get<Task>('tasks', taskId);
  if (!task) return undefined;
  if (task.conversationId === room.id) return task;
  if (chiefOwnsTask(state, room, botId, task) || chiefOwnsRoutineTask(state, room, botId, task))
    return task;
  const group = s.get<Conversation>('conversations', task.conversationId);
  const source = group?.sourceTaskId ? s.get<Task>('tasks', group.sourceTaskId) : undefined;
  return botId === state.settings().mainBotId &&
    room.purpose === 'chief' &&
    group?.purpose === 'task' &&
    !!source &&
    source.conversationId === group.sourceConversationId &&
    chiefOwnsTask(state, room, botId, source)
    ? task
    : undefined;
}

export function isBoundTaskDescendant(state: State, root: Task, candidate: Task): boolean {
  const s = state.storage;
  const seen = new Set<string>();
  let current = candidate;
  while (!seen.has(current.id)) {
    if (current.id === root.id) return true;
    seen.add(current.id);
    const parent = current.parentId ? s.get<Task>('tasks', current.parentId) : undefined;
    if (!parent) return false;
    if (current.conversationId !== parent.conversationId) {
      const group = s.get<Conversation>('conversations', current.conversationId);
      if (
        group?.purpose !== 'task' ||
        group.sourceTaskId !== parent.id ||
        group.sourceConversationId !== parent.conversationId
      )
        return false;
    }
    current = parent;
  }
  return false;
}

export function returnTaskArtifacts(
  state: State,
  room: Conversation,
  botId: string,
  task: Task,
  artifactIds: string[],
) {
  const s = state.storage;
  if (
    task.conversationId !== room.id &&
    (chiefOwnsTask(state, room, botId, task) || chiefOwnsRoutineTask(state, room, botId, task))
  ) {
    const valid = artifactIds.filter((id) => {
      const artifact = s.get<Artifact>('artifacts', id);
      const owner = artifact?.taskId ? s.get<Task>('tasks', artifact.taskId) : undefined;
      if (!owner || artifact?.conversationId !== owner.conversationId) return false;
      return isBoundTaskDescendant(state, task, owner);
    });
    const key = `chief-artifact-grants:${room.id}`;
    s.setMetadata(key, [...new Set([...(s.metadata<string[]>(key) ?? []), ...valid])]);
    return;
  }
  const group = s.get<Conversation>('conversations', task.conversationId);
  if (
    botId !== state.settings().mainBotId ||
    room.purpose !== 'chief' ||
    !group?.sourceConversationId ||
    !group.sourceTaskId
  )
    return;
  const source = s.get<Task>('tasks', group.sourceTaskId);
  if (
    !source ||
    source.conversationId !== group.sourceConversationId ||
    !chiefOwnsTask(state, room, botId, source)
  )
    return;
  const valid = artifactIds.filter(
    (artifactId) => s.get<Artifact>('artifacts', artifactId)?.conversationId === group.id,
  );
  const key = `returned-artifacts:${source.id}`;
  s.setMetadata(key, [...new Set([...(s.metadata<string[]>(key) ?? []), ...valid])]);
  if (source.conversationId !== room.id) {
    const grantKey = `chief-artifact-grants:${room.id}`;
    s.setMetadata(grantKey, [...new Set([...(s.metadata<string[]>(grantKey) ?? []), ...valid])]);
  }
}
