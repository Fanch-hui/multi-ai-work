import type {
  ChiefHistoryHit,
  ChiefHistoryReadResult,
  ChiefHistorySearchInput,
  ChiefHistorySearchResult,
} from '../domain/chief-history.js';
import type { ChiefContextPart, ChiefWorkContext } from '../domain/chief-work.js';
import type { Artifact, Conversation, Message, Run, Task } from '../domain/types.js';
import type { State } from './state.js';
import { ChiefHistoryIndex } from './chief-history-index.js';
import { searchChiefMessageIds } from './chief-history-query.js';
import { searchChiefTaskMessages } from './chief-history-task-query.js';
import { required } from './errors.js';

export class ChiefHistoryService {
  private index: ChiefHistoryIndex;
  constructor(private state: State) {
    this.index = new ChiefHistoryIndex(state.storage);
  }

  sync(limit = 200): boolean {
    return this.index.sync(new Set(this.rooms().map((room) => room.id)), limit);
  }

  rebuild() {
    this.index.rebuild();
  }

  search(input: ChiefHistorySearchInput = {}): ChiefHistorySearchResult {
    const limit = Math.max(1, Math.min(40, Math.floor(input.limit ?? 12)));
    const partial = this.sync();
    const rooms = this.rooms(input);
    if (!rooms.length) return { items: [], partial };
    const matched = searchChiefMessageIds(
      this.state.storage,
      rooms.map((room) => room.id),
      input,
      limit,
    );
    const metadata =
      matched.length < limit
        ? searchChiefTaskMessages(this.state.storage, rooms, input, limit)
        : [];
    const ids = [...new Set([...matched, ...metadata])].slice(0, limit);
    const items = ids.flatMap((id) => {
      const message = this.state.storage.getMessage(id);
      const room = rooms.find((room) => room.id === message?.conversationId);
      return message && room ? [this.hit(message, room, input.query, 1200)] : [];
    });
    return { items, partial };
  }

  read(input: { messageId: string; limit?: number }): ChiefHistoryReadResult {
    const s = this.state.storage;
    const source = s
      .prepare('SELECT conversation_id FROM messages WHERE id=?')
      .get(input.messageId) as { conversation_id: string } | undefined;
    if (!source) throw new Error('历史消息不存在');
    const room = required(
      this.rooms().find((room) => room.id === source.conversation_id),
      '历史消息不在管家获准的工作范围',
    );
    const anchor = required(s.getMessage(input.messageId), '历史消息不存在');
    if (anchor.status !== 'committed') throw new Error('历史消息尚未提交');
    const limit = Math.max(1, Math.min(15, Math.floor(input.limit ?? 7)));
    const count = Math.floor(limit / 2);
    const rows = s
      .prepare(`SELECT id FROM messages WHERE conversation_id=?
      AND json_extract(payload,'$.status')='committed' AND sequence>=?
      ORDER BY sequence LIMIT ?`)
      .all(room.id, Math.max(1, anchor.sequence - count), limit) as { id: string }[];
    return {
      anchorMessageId: anchor.id,
      conversationId: room.id,
      contextId: this.contextId(room),
      messages: rows.flatMap(({ id }) => {
        const message = s.getMessage(id);
        return message ? [this.hit(message, room, undefined, Math.floor(24000 / limit))] : [];
      }),
    };
  }

  private rooms(input: ChiefHistorySearchInput = {}): Conversation[] {
    const { mainBotId, mainConversationId } = this.state.settings();
    const s = this.state.storage;
    let ids: Set<string> | undefined;
    if (input.contextId) {
      const context = s.get<ChiefWorkContext>('chief_contexts', input.contextId);
      if (!context || context.homeConversationId !== mainConversationId) return [];
      ids = new Set(
        s
          .all<ChiefContextPart>('chief_parts')
          .filter((part) => part.contextId === context.id)
          .map((part) => part.conversationId),
      );
      if (context.legacyConversationId) ids.add(context.legacyConversationId);
    }
    return s
      .all<Conversation>('conversations')
      .filter(
        (room) =>
          room.kind === 'private' &&
          room.purpose === 'chief' &&
          room.chiefId === mainBotId &&
          room.chiefRole !== 'router' &&
          (!room.chiefHomeId || room.chiefHomeId === mainConversationId) &&
          (!ids || ids.has(room.id)) &&
          (!input.workspaceId || input.workspaceId === room.workspaceId),
      );
  }

  private contextId(room: Conversation): string | undefined {
    if (room.chiefContextId) return room.chiefContextId;
    return this.state.storage.firstByField<ChiefContextPart>(
      'chief_parts',
      'conversationId',
      room.id,
    )?.contextId;
  }

  private hit(
    message: Message,
    room: Conversation,
    query: string | undefined,
    max: number,
  ): ChiefHistoryHit {
    const s = this.state.storage;
    const run = message.runId ? s.get<Run>('runs', message.runId) : undefined;
    const row = !run
      ? (s
          .prepare(`SELECT payload FROM tasks WHERE json_extract(payload,'$.conversationId')=?
          AND json_extract(payload,'$.sourceMessageId')=? ORDER BY rowid DESC LIMIT 1`)
          .get(room.id, message.id) as { payload: string } | undefined)
      : undefined;
    let task = run ? s.get<Task>('tasks', run.taskId) : undefined;
    if (!run && row) task = JSON.parse(row.payload) as Task;
    const contextId = this.contextId(room);
    const context = contextId ? s.get<ChiefWorkContext>('chief_contexts', contextId) : undefined;
    const artifactIds = new Set(message.artifactIds);
    for (const id of task?.artifactIds ?? []) {
      const artifact = s.get<Artifact>('artifacts', id);
      if (artifact?.conversationId === room.id && artifact.taskId === task!.id) artifactIds.add(id);
    }
    return {
      messageId: message.id,
      conversationId: room.id,
      contextId,
      taskId: task?.id,
      workspaceId: room.workspaceId,
      sequence: message.sequence,
      createdAt: message.createdAt,
      authorType: message.authorType,
      title: context?.title ?? room.name,
      content: excerpt(message.content, query, max),
      artifactIds: [...artifactIds].filter((id) => !!s.get<Artifact>('artifacts', id)),
    };
  }
}

function excerpt(content: string, query: string | undefined, max: number): string {
  if (content.length <= max) return content;
  const words = query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const lower = content.toLocaleLowerCase();
  const found = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
  const start = Math.max(0, (found.length ? Math.min(...found) : 0) - Math.floor(max / 4));
  return `${start ? '…' : ''}${content.slice(start, start + max)}${start + max < content.length ? '…' : ''}`;
}
