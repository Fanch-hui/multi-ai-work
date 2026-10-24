import type { ChiefContextPart, ChiefWorkContext } from '../domain/chief-work.js';
import type { Routine } from '../domain/routines.js';
import type { Conversation } from '../domain/types.js';
import type { State } from './state.js';
import { required } from './errors.js';

function routinePart(state: State, routine: Routine): ChiefContextPart | undefined {
  if (routine.botId !== state.settings().mainBotId) return undefined;
  const s = state.storage;
  const room = s.get<Conversation>('conversations', routine.conversationId);
  if (!room?.chiefContextId) return undefined;
  const context = s.get<ChiefWorkContext>('chief_contexts', room.chiefContextId);
  if (context?.routineId !== routine.id) return undefined;
  return required(
    s.get<ChiefContextPart>('chief_parts', context.currentPartId),
    '例行工作段不存在',
  );
}

export function currentRoutineContext(state: State, routine: Routine): Routine {
  const part = routinePart(state, routine);
  if (!part || part.conversationId === routine.conversationId) return routine;
  const room = required(
    state.storage.get<Conversation>('conversations', part.conversationId),
    '例行工作会话已删除',
  );
  if (room.workspaceId !== routine.workspaceId || room.chiefId !== routine.botId)
    throw new Error('例行工作的项目或负责人已变化，请重新配置');
  return { ...routine, conversationId: room.id };
}

export function grantRoutineContextInputs(state: State, routine: Routine) {
  const part = routinePart(state, routine);
  if (!part || part.conversationId !== routine.conversationId) return;
  const key = `chief-artifact-grants:${routine.conversationId}`;
  state.storage.setMetadata(key, [
    ...new Set([
      ...(state.storage.metadata<string[]>(key) ?? []),
      ...routine.inputArtifactIds,
      ...part.sourceArtifactIds,
    ]),
  ]);
}
