import type { Bot, Conversation, Message, ToolConnection } from '../domain/types.js';
import type { Routine } from '../domain/routines.js';
import type {
  ConversationReference,
  ConversationReferenceOption,
} from '../domain/conversation-reference.js';
import type { State } from './state.js';
import { required } from './errors.js';
import { authorizedSkills } from './skills.js';
import { chiefConversationScope } from './chief-conversation-scope.js';
import type { ChiefInput, ChiefTimelineEntry } from '../domain/chief-work.js';

export function referenceOptions(
  state: State,
  roomId: string,
  targetIds: string[] = [],
): ConversationReferenceOption[] {
  const s = state.storage;
  const room = required(s.get<Conversation>('conversations', roomId), '对话不存在');
  if (room.archived) throw new Error('请先恢复会话');
  const ids = targetIds.length ? [...new Set(targetIds)] : room.memberIds;
  const bots = ids.map((id) => {
    const bot = required(s.get<Bot>('bots', id), '成员不存在');
    if (bot.archived || !room.memberIds.includes(id)) throw new Error('成员不属于当前会话');
    return bot;
  });
  if (!bots.length) return [];
  const skills = bots.map((bot) => authorizedSkills(state, bot));
  const related = chiefConversationScope(state, room);
  const options: ConversationReferenceOption[] = skills[0]
    .filter((skill) => skills.every((list) => list.some((item) => item.id === skill.id)))
    .map((skill) => ({
      kind: 'skill',
      id: skill.id,
      label: skill.name,
      description: skill.description,
    }));
  options.push(
    ...s
      .all<ToolConnection>('tool_connections')
      .filter(
        (item) =>
          item.enabled && bots.every((bot) => (bot.toolConnectionIds ?? []).includes(item.id)),
      )
      .map((item) => ({
        kind: 'connector' as const,
        id: item.id,
        label: item.name,
        description: item.status === 'ready' ? '已连接' : '需要配置或检测',
      })),
  );
  options.push(
    ...s
      .all<Routine>('routines')
      .filter((routine) =>
        bots.some((bot) => bot.id === routine.botId || bot.id === state.settings().mainBotId),
      )
      .map((routine) => ({
        kind: 'routine' as const,
        id: routine.id,
        label: routine.name,
        description: routine.nextRunAt,
      })),
  );
  options.push(
    ...s
      .all<Conversation>('conversations')
      .filter(
        (item) =>
          !item.archived &&
          item.kind === 'group' &&
          (item.id === room.id || item.sourceConversationId === room.id || related.has(item.id)),
      )
      .map((item) => ({
        kind: 'conversation' as const,
        id: item.id,
        label: item.name,
        description: '关联任务群',
      })),
  );
  return options;
}

export function resolveReferences(
  state: State,
  roomId: string,
  targets: string[],
  references: ConversationReference[] = [],
) {
  if (references.length > 12) throw new Error('每条消息最多引用 12 项');
  if (!references.length) return [];
  const options = referenceOptions(state, roomId, targets);
  const selected = new Map<string, ConversationReferenceOption>();
  for (const reference of references) {
    const option = required(
      options.find((item) => item.kind === reference.kind && item.id === reference.id),
      '引用已失效或当前成员未获授权',
    );
    selected.set(`${option.kind}:${option.id}`, option);
  }
  return [...selected.values()];
}

export function replyMessage(
  state: State,
  roomId: string,
  messageId?: string,
): Message | undefined {
  if (!messageId) return;
  const message = required(state.storage.getMessage(messageId), '引用消息已删除');
  if (message.conversationId !== roomId || message.status === 'draft')
    throw new Error('请选择当前会话已发表的消息');
  return message;
}

export function inputReplyMessage(state: State, message: Message): Message | undefined {
  if (!message.replyToMessageId) return;
  const s = state.storage;
  const reply = s.getMessage(message.replyToMessageId);
  if (!reply) return;
  if (reply.conversationId === message.conversationId) return reply;
  const entry = s.get<ChiefTimelineEntry>('chief_timeline', message.id);
  const input = entry?.inputId ? s.get<ChiefInput>('chief_inputs', entry.inputId) : undefined;
  const room = s.get<Conversation>('conversations', message.conversationId);
  if (
    input?.messageId === message.id &&
    input.replyToMessageId === reply.id &&
    input.homeConversationId === room?.chiefHomeId &&
    room?.chiefRole === 'main' &&
    room.chiefId === state.settings().mainBotId
  )
    return reply;
}

export function referencePrompt(message: Message, reply?: Message) {
  const labels = {
    skill: '技能',
    connector: '连接器',
    routine: '例行工作',
    conversation: '任务群',
  };
  const parts = (message.references ?? []).map(
    (item) => `${labels[item.kind]}：${item.label}（ID：${item.id}）`,
  );
  if (reply) parts.unshift(`用户回复消息 ${reply.id}：\n${reply.content.slice(0, 3000)}`);
  return parts.length
    ? `${message.content}\n\n[用户明确引用]\n${parts.join('\n')}\n引用仅指定本次工作对象，实际访问仍使用当前授权工具。`
    : message.content;
}
