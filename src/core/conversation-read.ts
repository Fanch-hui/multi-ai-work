import type { Conversation, Message } from '../domain/types.js';
import type { Storage } from './storage.js';
import { required } from './errors.js';

interface ReadPosition {
  sequence: number;
  pendingMessageIds: string[];
}
const key = (conversationId: string) => `conversation-read:${conversationId}`;
const incoming = (message: Message) => message.authorType === 'bot';
const whitespace =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const visible = (message: Message) => !!message.content.trim() || message.artifactIds.length > 0;
const position = (storage: Storage, conversationId: string): ReadPosition =>
  storage.metadata<ReadPosition>(key(conversationId)) ?? { sequence: 0, pendingMessageIds: [] };

export function initializeConversationReads(storage: Storage) {
  if (storage.metadata('conversation-reads-v1')) return;
  storage.transaction(() => {
    for (const room of storage.all<Conversation>('conversations')) {
      const messages = storage.messages(room.id);
      storage.setMetadata(key(room.id), {
        sequence: messages.at(-1)?.sequence ?? 0,
        pendingMessageIds: messages
          .filter((message) => incoming(message) && !visible(message) && message.status === 'draft')
          .map((message) => message.id),
      });
    }
    storage.setMetadata('conversation-reads-v1', true);
  });
}

export function unreadConversations(storage: Storage, messages: Message[]): Conversation[] {
  const counts = new Map<string, number>();
  const rooms = storage.all<Conversation>('conversations');
  const positions = new Map(rooms.map((room) => [room.id, position(storage, room.id)]));
  for (const message of messages) {
    const read = positions.get(message.conversationId);
    if (
      read &&
      incoming(message) &&
      visible(message) &&
      (message.sequence > read.sequence || read.pendingMessageIds.includes(message.id))
    )
      counts.set(message.conversationId, (counts.get(message.conversationId) ?? 0) + 1);
  }
  return rooms.map((room) => ({ ...room, unreadCount: counts.get(room.id) ?? 0 }));
}

export function readConversation(
  storage: Storage,
  conversationId: string,
  messageIds: string[],
): boolean {
  required(storage.get<Conversation>('conversations', conversationId), '对话不存在');
  const messages = storage.messages(conversationId),
    selected = new Set(messageIds);
  const seen = messages.filter((message) => selected.has(message.id));
  if (seen.length !== selected.size) throw new Error('消息不在当前会话中');
  const received = seen.filter((message) => incoming(message) && visible(message));
  if (!received.length) return false;
  const receivedIds = new Set(received.map((message) => message.id));
  const previous = position(storage, conversationId);
  const sequence = received.reduce(
    (cursor, message) => Math.max(cursor, message.sequence),
    previous.sequence,
  );
  // Empty or unseen parallel drafts can publish below the latest viewed message.
  const pendingMessageIds = messages
    .filter(
      (message) =>
        incoming(message) &&
        message.sequence <= sequence &&
        !receivedIds.has(message.id) &&
        (message.sequence > previous.sequence || previous.pendingMessageIds.includes(message.id)),
    )
    .map((message) => message.id);
  if (
    sequence === previous.sequence &&
    pendingMessageIds.join('|') === previous.pendingMessageIds.join('|')
  )
    return false;
  storage.setMetadata(key(conversationId), { sequence, pendingMessageIds });
  return true;
}

export function unreadConversationCounts(storage: Storage, ids?: string[]): Conversation[] {
  const rooms =
    ids === undefined
      ? storage.all<Conversation>('conversations')
      : ids
          .map((id) => storage.get<Conversation>('conversations', id))
          .filter((room): room is Conversation => !!room);
  return rooms.map((room) => {
    const read = position(storage, room.id);
    const filter = `conversation_id = ? AND json_extract(payload, '$.authorType') = 'bot'
      AND (sequence > ? OR id IN (SELECT value FROM json_each(?)))`;
    const args = [room.id, read.sequence, JSON.stringify(read.pendingMessageIds)];
    const count = storage
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${filter}
      AND json_extract(payload, '$.status') != 'draft'
      AND (length(trim(json_extract(payload, '$.content'), ?)) > 0 OR json_array_length(payload, '$.artifactIds') > 0)`)
      .get(...args, whitespace) as { count: number };
    const drafts = storage
      .prepare(
        `SELECT id FROM messages WHERE ${filter} AND json_extract(payload, '$.status') = 'draft'`,
      )
      .all(...args) as { id: string }[];
    const unreadCount =
      count.count +
      drafts.filter((row) => {
        const message = storage.getMessage(row.id);
        return !!message && visible(message);
      }).length;
    return { ...room, unreadCount };
  });
}
