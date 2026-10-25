import type { Artifact, Conversation, SessionBinding, Task } from '../domain/types.js';
import type { EntityTable } from './storage.js';
import { z } from 'zod';
import { required } from './errors.js';
import { State } from './state.js';
import { TaskService, terminal } from './tasks.js';
import { Scheduler } from './scheduler.js';
import { artifactRequirement, taskRequirement } from './task-requirements.js';
import { taskPlanRoot } from './task-plan-view.js';
import { removeChiefConversation } from './chief-conversation-cleanup.js';

export class ConversationService {
  constructor(
    private state: State,
    private tasks: TaskService,
    private scheduler: Scheduler,
  ) {}

  rename(conversationId: string, name: string): Conversation {
    const room = this.room(conversationId);
    const updated = {
      ...room,
      name: z
        .string()
        .trim()
        .min(1, '会话名称不能为空')
        .max(120, '会话名称最多 120 个字')
        .parse(name),
      nameEdited: true,
    };
    this.state.storage.put('conversations', updated);
    this.state.changed();
    return updated;
  }

  async archive(conversationId: string, archived: boolean): Promise<Conversation> {
    const room = this.room(conversationId);
    if (archived || room.timelineOnly) this.requireManageable(room);
    if (!!room.archived === archived) return room;
    return this.modify(room, async () => {
      if (archived) await this.cancelTasks(room.id);
      const updated = { ...this.room(room.id), archived };
      this.state.storage.put('conversations', updated);
      this.state.syncMainTeam();
      return updated;
    });
  }

  async delete(conversationId: string): Promise<void> {
    const room = this.room(conversationId);
    this.requireManageable(room);
    await this.deleteRooms([room]);
  }

  async deleteHistory(conversationIds: string[], assertIdle: () => void): Promise<void> {
    const rooms = [...new Set(conversationIds)].map((id) => this.room(id));
    await this.deleteRooms(rooms, assertIdle);
  }

  private async deleteRooms(rooms: Conversation[], assertIdle?: () => void) {
    const s = this.state.storage;
    const locked: string[] = [];
    try {
      for (const room of rooms) {
        this.tasks.blockConversation(room.id);
        locked.push(room.id);
      }
      assertIdle?.();
      if (!assertIdle) for (const room of rooms) await this.cancelTasks(room.id);
      await Promise.all(
        rooms.map((room) => this.state.artifactContents.retainConversation(room.id)),
      );
      assertIdle?.();
      s.transaction(() => {
        for (const room of rooms) {
          const retained = new Set<string>();
          if (assertIdle) {
            const ids = s
              .prepare(`SELECT id FROM messages WHERE conversation_id=? AND
              (conversation_id=? OR id IN (SELECT json_extract(payload,'$.messageId') FROM chief_timeline))`)
              .all(room.id, this.state.settings().mainConversationId) as { id: string }[];
            for (const row of ids) retained.add(row.id);
          }
          removeChiefConversation(this.state, room.id, retained);
          this.deleteRecords(room.id, retained);
          if (room.id === this.state.settings().mainConversationId || retained.size) {
            s.put('conversations', {
              ...room,
              chiefContextId: undefined,
              archived: room.id !== this.state.settings().mainConversationId,
              timelineOnly: room.id !== this.state.settings().mainConversationId,
            });
          } else s.delete('conversations', room.id);
        }
        this.state.syncMainTeam();
      });
    } finally {
      for (const id of locked) this.tasks.unblockConversation(id);
      this.state.changed();
    }
  }

  async updateMembers(conversationId: string, memberIds: string[]): Promise<Conversation> {
    const room = this.room(conversationId),
      s = this.state.storage;
    if (room.archived) throw new Error('请先恢复群聊');
    if (room.kind !== 'group') throw new Error('只有群聊可以管理成员');
    const chiefId = required(room.chiefId, '群聊缺少管家');
    const members = [...new Set([chiefId, ...memberIds])];
    if (members.length > 50) throw new Error('群聊最多支持 50 位智能体');
    for (const memberId of members) {
      const bot = required(
        s.get<{ id: string; archived: boolean }>('bots', memberId),
        '智能体不存在',
      );
      if (bot.archived) throw new Error('智能体已归档');
    }
    return this.modify(room, async () => {
      await this.cancelTasks(
        room.id,
        new Set(room.memberIds.filter((memberId) => !members.includes(memberId))),
      );
      const updated = { ...this.room(room.id), memberIds: members };
      s.put('conversations', updated);
      return updated;
    });
  }

  private room(conversationId: string) {
    return required(
      this.state.storage.get<Conversation>('conversations', conversationId),
      '对话不存在',
    );
  }

  private requireManageable(room: Conversation) {
    if (room.timelineOnly) throw new Error('主对话消息持续保留，任务记录已在历史任务中管理');
    if (room.chiefRole === 'home' || room.id === this.state.settings().mainConversationId)
      throw new Error('管家主入口需要保留，请在历史中管理其他对话。');
    if (
      room.chiefContextId &&
      this.state.storage.get<{ kind?: string }>('chief_contexts', room.chiefContextId)?.kind ===
        'main'
    )
      throw new Error('管家主对话上下文持续保留');
  }

  private async modify<T>(room: Conversation, action: () => Promise<T>): Promise<T> {
    this.tasks.blockConversation(room.id);
    try {
      return await action();
    } finally {
      this.tasks.unblockConversation(room.id);
      this.state.changed();
    }
  }

  private async cancelTasks(conversationId: string, botIds?: Set<string>) {
    const tasks = this.state.storage
      .all<Task>('tasks')
      .filter(
        (task) =>
          task.conversationId === conversationId &&
          !terminal(task.status) &&
          (!botIds || botIds.has(task.botId)),
      );
    await Promise.all(tasks.map((task) => this.scheduler.cancel(task.id)));
  }

  private deleteRecords(conversationId: string, retained = new Set<string>()) {
    const s = this.state.storage;
    const tasks = s.all<Task>('tasks').filter((task) => task.conversationId === conversationId);
    const taskIds = new Set(tasks.map((task) => task.id));
    for (const artifact of s.all<Artifact>('artifacts')) {
      const producer = artifact.taskId ? s.get<Task>('tasks', artifact.taskId) : undefined;
      if (producer && taskIds.has((taskPlanRoot(s, producer) ?? producer).id))
        s.put('artifacts', artifactRequirement(s, artifact));
    }
    for (const retained of s
      .all<Task>('tasks')
      .filter((task) => taskIds.has(task.parentId ?? '') && task.conversationId !== conversationId))
      s.setMetadata(`requirements:${retained.id}`, {
        ...taskRequirement(s, retained),
        taskId: retained.id,
      });
    const runIds = new Set(
      s
        .all<{ id: string; taskId: string }>('runs')
        .filter((run) => taskIds.has(run.taskId))
        .map((run) => run.id),
    );
    const bindingIds = new Set(
      s
        .all<SessionBinding>('session_bindings')
        .filter((binding) => binding.conversationId === conversationId)
        .map((binding) => binding.id),
    );
    const tables: EntityTable[] = [
      'tasks',
      'runs',
      'session_bindings',
      'approvals',
      'context_checkpoints',
      'compactions',
      'provider_archive',
      'managed_progress_deltas',
      'tool_operations',
      'deliveries',
      'notifications',
      'questions',
      'task_waits',
      'processes',
      'task_plans',
    ];
    for (const table of tables) {
      for (const row of s.all<{
        id: string;
        taskId?: string;
        runId?: string;
        bindingId?: string;
        parentId?: string;
        childIds?: string[];
      }>(table)) {
        if (
          taskIds.has(row.id) ||
          runIds.has(row.id) ||
          bindingIds.has(row.id) ||
          taskIds.has(row.taskId ?? '') ||
          runIds.has(row.runId ?? '') ||
          bindingIds.has(row.bindingId ?? '') ||
          (table === 'notifications' &&
            (taskIds.has(row.parentId ?? '') ||
              row.childIds?.some((childId) => taskIds.has(childId))))
        )
          s.delete(table, row.id);
      }
    }
    if (retained.size) {
      for (const message of s.messages(conversationId))
        if (!retained.has(message.id)) s.deleteMessage(message.id);
    } else s.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    for (const runId of runIds) s.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
    this.deleteMetadata(conversationId, taskIds, bindingIds, retained.size > 0);
    this.detachReferences(conversationId, taskIds);
  }

  private deleteMetadata(
    conversationId: string,
    taskIds: Set<string>,
    bindingIds: Set<string>,
    retainedMessages = false,
  ) {
    const db = this.state.storage.db;
    if (!retainedMessages) {
      db.prepare('DELETE FROM metadata WHERE key = ?').run(`conversation-read:${conversationId}`);
      db.prepare('DELETE FROM metadata WHERE key = ?').run(`message-sequence:${conversationId}`);
    }
    const rows = db
      .prepare(
        'SELECT key, value FROM metadata WHERE key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ?',
      )
      .all(
        'send:%',
        'task-group:%',
        'history:%',
        'history-validity:%',
        'results:%',
        'coordination:%',
        'requirements:%',
        'returned-artifacts:%',
        'context-projection:%',
      ) as { key: string; value: string }[];
    const remove = db.prepare('DELETE FROM metadata WHERE key = ?');
    for (const row of rows) {
      const value = JSON.parse(row.value) as {
        conversationId?: string;
        taskId?: string;
        taskIds?: string[];
      };
      const suffix = row.key.slice(row.key.indexOf(':') + 1);
      if (
        taskIds.has(suffix) ||
        bindingIds.has(suffix) ||
        value.conversationId === conversationId ||
        taskIds.has(value.taskId ?? '') ||
        value.taskIds?.some((taskId) => taskIds.has(taskId)) ||
        [...taskIds].some(
          (taskId) =>
            row.key.startsWith(`task-group:${taskId}:`) ||
            row.key.startsWith(`context-projection:${taskId}:`),
        )
      )
        remove.run(row.key);
      else if (row.key.startsWith('results:') && Array.isArray(value))
        this.state.storage.setMetadata(
          row.key,
          value.filter((item) => !taskIds.has(item.taskId)),
        );
    }
  }

  private detachReferences(conversationId: string, taskIds: Set<string>) {
    const s = this.state.storage;
    for (const room of s
      .all<Conversation>('conversations')
      .filter((room) => room.sourceConversationId === conversationId))
      s.put('conversations', {
        ...room,
        sourceConversationId: undefined,
        sourceTaskId: undefined,
        sourceMessageId: undefined,
      });
    for (const task of s.all<Task>('tasks')) {
      if (taskIds.has(task.parentId ?? '')) s.put('tasks', { ...task, parentId: undefined });
      if (
        task.status === 'waiting_children' &&
        !s.all<Task>('tasks').some((child) => child.parentId === task.id)
      )
        this.tasks.update(task, {
          status: 'waiting_input',
          error: '关联群聊已删除，可在主对话继续。',
        });
    }
  }
}
