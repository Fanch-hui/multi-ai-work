import type { Bot, Conversation, Task, UserQuestion } from '../domain/types.js';
import type { State } from './state.js';

export const memberQuestionDelayMs = 2 * 60 * 1000;
export const questionDeadline = (createdAt: string) => new Date(Date.parse(createdAt) + memberQuestionDelayMs).toISOString();

export function questionChief(state: State, question: UserQuestion): Bot | undefined {
  const s = state.storage, chiefId = state.settings().mainBotId;
  if (!chiefId || question.botId === chiefId) return;
  const task = s.get<Task>('tasks', question.taskId);
  const parent = task?.parentId ? s.get<Task>('tasks', task.parentId) : undefined;
  const room = s.get<Conversation>('conversations', question.conversationId);
  const member = s.get<Bot>('bots', question.botId), chief = s.get<Bot>('bots', chiefId);
  if (!task || task.botId !== question.botId || task.conversationId !== room?.id || task.reconciliationRequired
    || !parent || parent.botId !== chiefId || parent.conversationId !== room.id
    || ['completed', 'failed', 'cancelled', 'interrupted'].includes(parent.status)) return;
  if (!room || room.kind !== 'group' || room.chiefId !== chiefId || room.archived
    || !member || member.archived || !chief || chief.archived
    || !room.memberIds.includes(member.id) || !room.memberIds.includes(chief.id)) return;
  return chief;
}
