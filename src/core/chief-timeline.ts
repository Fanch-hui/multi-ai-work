import type { State } from './state.js';
import type {
  ChiefContextPart,
  ChiefInput,
  ChiefTimelineEntry,
  ChiefTimelinePage,
} from '../domain/chief-work.js';
import type { Conversation, Message } from '../domain/types.js';
import { readConversation } from './conversation-read.js';
import { required } from './errors.js';

export class ChiefTimelineService {
  constructor(private state: State) {}
  get homeId() {
    return this.state.settings().mainConversationId!;
  }
  add(messageId: string, inputId?: string) {
    const s = this.state.storage;
    if (s.get<ChiefTimelineEntry>('chief_timeline', messageId)) return;
    const key = `chief-timeline-sequence:${this.homeId}`;
    const displaySequence = (s.metadata<number>(key) ?? 0) + 1;
    s.put<ChiefTimelineEntry>('chief_timeline', {
      id: messageId,
      homeConversationId: this.homeId,
      displaySequence,
      messageId,
      inputId,
    });
    s.setMetadata(key, displaySequence);
  }
  sync(messageIds: string[]) {
    const s = this.state.storage;
    if (!s.metadata('chief-timeline-v1')) {
      s.transaction(() => {
        for (const message of s.messages(this.homeId)) this.addVisible(message);
        s.setMetadata('chief-timeline-v1', true);
      });
    }
    for (const id of messageIds) {
      const message = s.getMessage(id);
      if (message) this.addVisible(message);
    }
  }
  private addVisible(message: Message) {
    if (message.authorType === 'system' || (!message.content.trim() && !message.artifactIds.length))
      return;
    const room = this.state.storage.get<Conversation>('conversations', message.conversationId);
    if (room?.chiefHomeId !== this.homeId || room.chiefRole === 'router' || room.kind !== 'private')
      return;
    if (
      room.id !== this.homeId &&
      !this.state.storage.firstByField<ChiefContextPart>('chief_parts', 'conversationId', room.id)
    )
      return;
    this.add(message.id);
  }
  project(entry: ChiefTimelineEntry): Message | undefined {
    const s = this.state.storage;
    const message = s.getMessage(entry.messageId);
    if (message) {
      const room = s.get<Conversation>('conversations', message.conversationId);
      return {
        ...message,
        chiefTimelineSequence: entry.displaySequence,
        chiefContextId: room?.chiefContextId,
        chiefInputId: entry.inputId,
      };
    }
    const input = entry.inputId ? s.get<ChiefInput>('chief_inputs', entry.inputId) : undefined;
    if (!input?.content) return undefined;
    return {
      id: input.messageId,
      conversationId: this.homeId,
      sequence: 0,
      authorType: 'user',
      content: input.content,
      artifactIds: input.artifactIds,
      status: 'committed',
      createdAt: input.createdAt,
      chiefTimelineSequence: entry.displaySequence,
      chiefContextId: input.contextId ?? input.targetContextId,
      chiefInputId: input.id,
    };
  }
  page(before = Number.MAX_SAFE_INTEGER, limit = 50, from?: number): ChiefTimelinePage {
    this.sync(this.state.storage.changes.ids('messages'));
    const size = Math.max(1, Math.min(200, limit));
    const s = this.state.storage;
    const rows = s
      .prepare(`SELECT payload FROM chief_timeline WHERE json_extract(payload, '$.homeConversationId') = ?
      AND json_extract(payload, '$.displaySequence') ${from === undefined ? '<' : '>='} ?
      ORDER BY json_extract(payload, '$.displaySequence') DESC ${from === undefined ? 'LIMIT ?' : ''}`)
      .all(...(from === undefined ? [this.homeId, before, size + 1] : [this.homeId, from])) as {
      payload: string;
    }[];
    const entries = rows
      .slice(0, from === undefined ? size : rows.length)
      .map((row) => JSON.parse(row.payload) as ChiefTimelineEntry)
      .reverse();
    const messages = entries.flatMap((entry) => {
      const message = this.project(entry);
      return message ? [message] : [];
    });
    return {
      messages,
      ...(rows.length > size && from === undefined
        ? { nextBefore: entries[0]?.displaySequence }
        : {}),
    };
  }
  changes(messageIds: string[]): Message[] {
    return [...new Set(messageIds)].flatMap((id) => {
      const entry = this.state.storage.get<ChiefTimelineEntry>('chief_timeline', id);
      const message = entry && this.project(entry);
      return message ? [message] : [];
    });
  }
  read(messageIds: string[]) {
    this.sync(this.state.storage.changes.ids('messages'));
    const groups = new Map<string, string[]>();
    for (const id of new Set(messageIds)) {
      const entry = required(
        this.state.storage.get<ChiefTimelineEntry>('chief_timeline', id),
        '消息不在管家时间线中',
      );
      if (entry.homeConversationId !== this.homeId) throw new Error('消息不在管家时间线中');
      const message = this.state.storage.getMessage(id);
      if (message)
        groups.set(message.conversationId, [...(groups.get(message.conversationId) ?? []), id]);
    }
    let changed = false;
    this.state.storage.transaction(() => {
      for (const [roomId, ids] of groups)
        if (readConversation(this.state.storage, roomId, ids)) {
          this.state.storage.changes.mark('conversation_reads', roomId);
          changed = true;
        }
    });
    return changed;
  }
  unreadCount() {
    const s = this.state.storage;
    const rows = s
      .prepare(`SELECT m.payload, m.stream_sequence FROM chief_timeline t JOIN messages m
      ON m.id = json_extract(t.payload, '$.messageId')
      LEFT JOIN metadata r ON r.key = 'conversation-read:' || m.conversation_id
      WHERE json_extract(t.payload, '$.homeConversationId') = ? AND json_extract(m.payload, '$.authorType') = 'bot'
      AND (m.sequence > COALESCE(json_extract(r.value, '$.sequence'), 0)
        OR m.id IN (SELECT value FROM json_each(COALESCE(json_extract(r.value, '$.pendingMessageIds'), '[]'))))`)
      .all(this.homeId) as { payload: string }[];
    return rows.filter((row) => {
      const original = JSON.parse(row.payload) as Message;
      const message = original.status === 'draft' ? s.getMessage(original.id)! : original;
      return message.content.trim() || message.artifactIds.length;
    }).length;
  }
}
