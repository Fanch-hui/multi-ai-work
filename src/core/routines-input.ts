import { statSync } from 'node:fs';
import type { z } from 'zod';
import { routineInputSchema } from '../domain/routine-input.js';
export { routineInputSchema } from '../domain/routine-input.js';
import type { Routine } from '../domain/routines.js';
import type { Artifact, Bot, Connection, Conversation, Workspace } from '../domain/types.js';
import { required } from './errors.js';
import type { State } from './state.js';
import { accessibleArtifacts } from './tool-access.js';
import { validateRoutineSchedule } from './routines-time.js';

export function routineReferences(state: State, routine: Pick<Routine, 'botId' | 'workspaceId'>) {
  const bot = required(state.storage.get<Bot>('bots', routine.botId), '例行工作负责人不存在');
  if (bot.archived) throw new Error('例行工作负责人已归档');
  const connection = required(
    state.storage.get<Connection>('connections', bot.connectionId),
    '例行工作连接不存在',
  );
  if (connection.status !== 'ready') throw new Error('请完成例行工作负责人的连接');
  if (!bot.model) throw new Error('请配置例行工作负责人的模型');
  const workspace = required(
    state.storage.get<Workspace>('workspaces', routine.workspaceId),
    '例行工作工作区不存在',
  );
  if (workspace.enabled === false) throw new Error('例行工作工作区授权已撤销');
  try {
    if (!statSync(workspace.path).isDirectory()) throw new Error();
  } catch {
    throw new Error('例行工作工作区不可用，请检查目录');
  }
  return bot;
}

export function validateRoutineInput(state: State, input: z.infer<typeof routineInputSchema>) {
  routineReferences(state, input);
  validateRoutineSchedule(input.schedule, input.timeZone);
  for (const artifactId of input.inputArtifactIds) {
    const artifact = required(
      state.storage.get<Artifact>('artifacts', artifactId),
      '输入资料不存在',
    );
    const room = required(
      state.storage.get<Conversation>('conversations', artifact.conversationId),
      '输入资料的会话已删除，请重新选择资料',
    );
    if (!room.memberIds.includes(input.botId)) throw new Error('输入资料未授权给所选负责人');
    if (!accessibleArtifacts(state, room, input.botId).some((item) => item.id === artifactId))
      throw new Error('输入资料未授权');
  }
}
