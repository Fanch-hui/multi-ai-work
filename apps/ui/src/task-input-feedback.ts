import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import { activeTask } from './components.js';
import { acceptsTaskInput } from '../../../src/domain/task-status.js';

export function busyInputMembers(
  data: Pick<Snapshot, 'bots' | 'tasks' | 'taskInputs'>,
  conversation: Conversation,
  targets: string[],
) {
  const pending = new Set(
    (data.taskInputs ?? [])
      .filter((input) => input.status !== 'delivered')
      .map((input) => input.taskId),
  );
  const members = data.bots.filter(
    (bot) =>
      !bot.archived &&
      conversation.memberIds.includes(bot.id) &&
      (conversation.purpose === 'chief'
        ? bot.id === conversation.chiefId
        : !targets.length || targets.includes(bot.id)),
  );
  return members.filter((bot) =>
    data.tasks.some(
      (task) =>
        task.conversationId === conversation.id &&
        task.botId === bot.id &&
        acceptsTaskInput(task, pending.has(task.id)),
    ),
  );
}

type FeedbackData = Pick<Snapshot, 'taskInputs' | 'tasks' | 'bots'> &
  Partial<Pick<Snapshot, 'messages'>>;
interface InputFeedback {
  id: string;
  name: string;
  status: string;
}

export function messageInputFeedbackIndex(data: FeedbackData, conversationId: string) {
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  const bots = new Map(data.bots.map((bot) => [bot.id, bot]));
  const feedback = new Map<string, InputFeedback[]>(),
    receivers = new Map<string, Set<string>>();
  function append(messageId: string, botId: string, item: InputFeedback) {
    const items = feedback.get(messageId) ?? [],
      members = receivers.get(messageId) ?? new Set<string>();
    items.push(item);
    members.add(botId);
    feedback.set(messageId, items);
    receivers.set(messageId, members);
  }
  for (const input of data.taskInputs ?? []) {
    if (input.conversationId !== conversationId) continue;
    const task = tasks.get(input.taskId);
    const status =
      input.status === 'delivered'
        ? '成员已接收'
        : !task || !activeTask(task.status)
          ? '任务已结束，保留待接入'
          : input.status === 'claimed'
            ? '已接入当前请求，待确认'
            : '等待接入';
    append(input.messageId, input.botId, {
      id: input.id,
      name: bots.get(input.botId)?.name || '成员',
      status,
    });
  }
  for (const task of data.tasks) {
    if (
      task.conversationId !== conversationId ||
      !task.sourceMessageId ||
      receivers.get(task.sourceMessageId)?.has(task.botId)
    )
      continue;
    const status = task.runIds.length
      ? '成员已开始'
      : activeTask(task.status)
        ? '任务已派发'
        : '任务已结束，尚未开始';
    append(task.sourceMessageId, task.botId, {
      id: task.id,
      name: bots.get(task.botId)?.name || '成员',
      status,
    });
  }
  for (const message of data.messages ?? []) {
    if (
      message.conversationId === conversationId &&
      message.authorType === 'user' &&
      message.status === 'committed' &&
      !feedback.has(message.id)
    )
      feedback.set(message.id, [{ id: message.id, name: '消息', status: '已发布' }]);
  }
  return feedback;
}

export function messageInputFeedback(
  data: FeedbackData,
  messageId: string,
  conversationId: string,
) {
  return messageInputFeedbackIndex(data, conversationId).get(messageId) ?? [];
}
