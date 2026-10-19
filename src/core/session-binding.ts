import { createHash } from 'node:crypto';
import type {
  Bot,
  Connection,
  Conversation,
  SessionBinding,
  Skill,
  Workspace,
} from '../domain/types.js';
import { State, id } from './state.js';

export function sessionBinding(
  state: State,
  bot: Bot,
  room: Conversation,
  connection: Connection,
  workspace: Workspace,
  purpose?: SessionBinding['purpose'],
  scopeId?: string,
): SessionBinding {
  const s = state.storage;
  const identityHash = createHash('sha256')
    .update(
      JSON.stringify({
        role: bot.role,
        instructions: bot.instructions,
        workspacePath: workspace.path,
        roomKind: room.kind,
        roomPurpose: room.purpose,
        chiefId: room.chiefId,
        scopeId,
        skills: [...bot.skillIds].sort().map((skillId) => {
          const skill = s.get<Skill>('skills', skillId);
          return [skillId, skill?.content, ...(skill?.digest ? [skill.digest] : [])];
        }),
      }),
    )
    .digest('hex');
  const previous = s.latestBinding(bot.id, room.id, purpose);
  // Older bindings have no identity snapshot; their recorded revision must still match.
  const sameIdentity = previous?.identityHash
    ? previous.identityHash === identityHash
    : previous?.configRevision === bot.revision;
  if (
    previous &&
    sameIdentity &&
    previous.connectionId === connection.id &&
    previous.connectionRevision === connection.revision &&
    previous.workspaceId === room.workspaceId &&
    previous.accountScope === connection.accountScope &&
    previous.model === bot.model &&
    previous.reasoning === bot.reasoning
  ) {
    const updated = {
      ...previous,
      identityHash,
      configRevision: bot.revision,
      model: bot.model,
      reasoning: bot.reasoning,
    };
    s.put('session_bindings', updated);
    return updated;
  }
  const binding: SessionBinding = {
    id: id(),
    botId: bot.id,
    conversationId: room.id,
    connectionId: connection.id,
    generation: (previous?.generation ?? 0) + 1,
    configRevision: bot.revision,
    connectionRevision: connection.revision,
    workspaceId: room.workspaceId,
    lastDeliveredSequence: 0,
    accountScope: connection.accountScope,
    purpose,
    model: bot.model,
    reasoning: bot.reasoning,
    identityHash,
  };
  s.put('session_bindings', binding);
  return binding;
}
