import { z } from 'zod';
import type { Bot, Connection, Conversation, MemoryEntry, Task } from '../domain/types.js';
import { MemoryService } from '../runtime/memory.js';
import { State, id, now } from './state.js';
import { TaskService } from './tasks.js';
import { required } from './errors.js';
import { assertUserMemorySources, memoryGuidance } from './memory-policy.js';

const fields = z.object({ id: z.string().optional(), content: z.string().trim().min(1).max(20000),
  scope: z.enum(['bot', 'team', 'shared']), ownerId: z.string().min(1),
  allowedConversationIds: z.array(z.string()).default([]), sourceIds: z.array(z.string()).default([]) });

export class MemoryManagement {
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private state: State, private memory: MemoryService, private tasks: TaskService) {}

  start() {
    this.unsubscribe = this.state.subscribe(kind => { if (kind === 'state') this.schedule(); });
    this.schedule();
  }
  close() { this.unsubscribe?.(); if (this.timer) clearTimeout(this.timer); }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.queueReviews(); }, 30);
  }

  save(input: unknown): MemoryEntry {
    const parsed = fields.parse(input), s = this.state.storage;
    const old = parsed.id ? required(s.get<MemoryEntry>('memory_entries', parsed.id), '记忆不存在') : undefined;
    if (parsed.scope === 'bot') required(s.get<Bot>('bots', parsed.ownerId), '所属成员不存在');
    if (parsed.scope === 'team') required(s.get<Conversation>('conversations', parsed.ownerId), '所属会话不存在');
    for (const roomId of parsed.allowedConversationIds) required(s.get('conversations', roomId), '授权会话不存在');
    const entry: MemoryEntry = { ...parsed, id: old?.id ?? id(),
      allowedConversationIds: parsed.scope === 'team' ? [parsed.ownerId] : [...new Set(parsed.allowedConversationIds)],
      status: 'approved', revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now(), updatedAt: now() };
    s.put('memory_entries', entry); this.state.changed(); return entry;
  }

  manage(input: Record<string, unknown>, botId: string, conversationId: string): unknown {
    const action = z.enum(['list', 'save', 'approve', 'revoke']).parse(input.action), s = this.state.storage;
    const owns = (entry: Pick<MemoryEntry, 'scope' | 'ownerId'>) => entry.scope === 'bot' ? entry.ownerId === botId
      : botId === this.state.settings().mainBotId;
    const entry = input.id ? required(s.get<MemoryEntry>('memory_entries', z.string().parse(input.id)), '记忆不存在') : undefined;
    if (entry && !owns(entry)) throw new Error('只能管理自己的记忆；团队公共记忆由管家管理');
    if (action === 'list') return entry ?? s.all<MemoryEntry>('memory_entries')
      .filter(item => owns(item) && ['candidate', 'approved'].includes(item.status)).slice(-200);
    if (action === 'revoke') return this.revoke(z.string().parse(input.id));
    if (action === 'approve') {
      if (!entry) throw new Error('请选择要保存的记忆');
      return entry.status === 'approved' ? entry : this.save(entry);
    }
    const scope = input.scope ?? entry?.scope ?? 'bot';
    const ownerId = input.ownerId ?? (entry?.scope === scope ? entry.ownerId : scope === 'team' ? conversationId : botId);
    const parsed = fields.parse({ allowedConversationIds: [conversationId], ...entry, ...input, scope, ownerId });
    if (!owns(parsed)) throw new Error('不能修改其他成员的记忆');
    const authorizedRooms = parsed.scope === 'team' ? [parsed.ownerId] : parsed.allowedConversationIds;
    if (authorizedRooms.some(roomId => !s.get<Conversation>('conversations', roomId)?.memberIds.includes(botId)))
      throw new Error('记忆只能授权给自己参与的会话');
    if (!entry || parsed.sourceIds.length) assertUserMemorySources(this.state, parsed.sourceIds, authorizedRooms);
    return this.save(parsed);
  }

  revoke(memoryId: string) {
    const entry = this.memory.revoke(memoryId);
    this.state.changed(); return entry;
  }

  private queueReviews() {
    const s = this.state.storage, settings = this.state.settings();
    const existing = s.all<Task>('tasks');
    for (const entry of s.all<MemoryEntry>('memory_entries').filter(item => item.status === 'candidate')) {
      const owner = s.get<Bot>('bots', entry.scope === 'bot' ? entry.ownerId : settings.mainBotId!);
      const connection = owner && s.get<Connection>('connections', owner.connectionId);
      const room = s.all<Conversation>('conversations').find(item => this.tasks.accepting(item.id) && item.memberIds.includes(owner?.id ?? '')
        && (entry.scope !== 'bot' ? item.purpose === 'chief' : entry.allowedConversationIds.includes(item.id)));
      if (!owner?.model || owner.archived || owner.memoryMode === 'off' || !room || connection?.status !== 'ready') continue;
      const requestId = `memory:${entry.id}:${entry.revision}:${owner.revision}:${connection.revision}`;
      if (existing.some(task => task.requestId === requestId)) continue;
      const task = this.tasks.create({ conversationId: room.id, botId: owner.id, requestId,
        goal: `整理长期记忆 ${entry.id}。用 manage_memory 读取内容，${memoryGuidance}有长期价值则编辑后保存或 approve；单次任务事实、无价值或重复内容则 revoke。保留原授权范围，不复制其他私聊内容。`,
        expectedOutput: '完成实际记忆管理操作；最后只简短说明处理结果。' });
      s.put('tasks', { ...task, kind: 'memory-review' });
    }
  }
}
