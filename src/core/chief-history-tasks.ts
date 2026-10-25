import type {
  ChiefHistoryInstruction,
  ChiefHistoryTaskList,
  ChiefHistoryTaskListInput,
  ChiefHistoryTaskRead,
  ChiefHistoryTaskReadInput,
  ChiefHistoryTaskView,
} from '../domain/chief-history-tasks.js';
import type { ChiefContextPart, ChiefWorkContext } from '../domain/chief-work.js';
import type { Conversation, Message, Task } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import type { State } from './state.js';
import type { ConversationService } from './conversations.js';
import { required } from './errors.js';

export class ChiefHistoryTasks {
  constructor(
    private state: State,
    private conversations: () => ConversationService,
  ) {}

  list(input: ChiefHistoryTaskListInput = {}): ChiefHistoryTaskList {
    const s = this.state.storage;
    const query = input.query?.trim().toLocaleLowerCase();
    const ordered = s
      .byField<ChiefWorkContext>('chief_contexts', 'homeConversationId', this.homeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const boundary = input.before
      ? ordered.findIndex((context) => context.id === input.before)
      : -1;
    if (input.before && boundary < 0) throw new Error('历史任务游标不存在，请刷新列表');
    const items = ordered
      .slice(boundary + 1)
      .filter((context) => !query || context.title.toLocaleLowerCase().includes(query))
      .flatMap((context) => (this.parts(context).length ? [this.view(context)] : []));
    const limit = input.limit ?? 30;
    return {
      items: items.slice(0, limit),
      ...(items.length > limit ? { nextBefore: items[limit - 1]!.id } : {}),
    };
  }

  read(input: ChiefHistoryTaskReadInput): ChiefHistoryTaskRead {
    const context = this.owned(input.contextId);
    const parts = this.parts(context);
    const part = required(
      parts.find((item) => item.id === (input.partId ?? context.currentPartId)),
      '上下文段不存在',
    );
    const page = this.state.storage.messagePage(
      part.conversationId,
      input.before,
      input.limit ?? 40,
    );
    const tasks = this.tasks(parts);
    return {
      context: this.view(context),
      parts,
      part,
      ...page,
      instructions: this.instructions(context, part, page.messages, tasks),
      tasks,
    };
  }

  async delete(contextId: string) {
    const context = this.owned(contextId);
    const roomIds = this.parts(context)
      .map((part) => part.conversationId)
      .sort();
    if (!roomIds.length) throw new Error('历史任务没有可管理的执行上下文');
    const assertIdle = () => {
      const current = this.owned(contextId);
      const currentIds = this.parts(current)
        .map((part) => part.conversationId)
        .sort();
      if (JSON.stringify(currentIds) !== JSON.stringify(roomIds))
        throw new Error('工作上下文已更新，请刷新后重试');
      const reason = this.blocked(current, this.parts(current), this.tasks(this.parts(current)));
      if (reason) throw new Error(reason);
    };
    assertIdle();
    await this.conversations().deleteHistory(roomIds, assertIdle);
    return { deletedContextId: contextId };
  }

  private get homeId() {
    return this.state.settings().mainConversationId!;
  }

  private owned(id: string) {
    const context = required(
      this.state.storage.get<ChiefWorkContext>('chief_contexts', id),
      '历史任务不存在',
    );
    if (context.homeConversationId !== this.homeId) throw new Error('历史任务不属于当前管家');
    return context;
  }

  private parts(context: ChiefWorkContext) {
    const s = this.state.storage;
    return s
      .byField<ChiefContextPart>('chief_parts', 'contextId', context.id)
      .filter((part) => {
        const room = s.get<Conversation>('conversations', part.conversationId);
        return (
          room?.kind === 'private' &&
          room.purpose === 'chief' &&
          room.chiefId === this.state.settings().mainBotId &&
          !room.timelineOnly &&
          (!room.chiefHomeId || room.chiefHomeId === this.homeId) &&
          room.chiefRole !== 'router'
        );
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private tasks(parts: ChiefContextPart[]) {
    return parts.flatMap((part) =>
      this.state.storage.byField<Task>('tasks', 'conversationId', part.conversationId),
    );
  }

  private relatedTasks(tasks: Task[], parts: ChiefContextPart[]) {
    const s = this.state.storage;
    const related = new Map(tasks.map((task) => [task.id, task]));
    const rooms = new Set(parts.map((part) => part.conversationId));
    for (const room of s.all<Conversation>('conversations')) {
      if (!rooms.has(room.sourceConversationId ?? '')) continue;
      for (const task of s.byField<Task>('tasks', 'conversationId', room.id))
        related.set(task.id, task);
    }
    const queue = [...related.values()];
    for (const task of queue)
      for (const child of s.byField<Task>('tasks', 'parentId', task.id))
        if (!related.has(child.id)) {
          related.set(child.id, child);
          queue.push(child);
        }
    return [...related.values()];
  }

  private blocked(context: ChiefWorkContext, parts: ChiefContextPart[], tasks: Task[]) {
    const s = this.state.storage;
    if (context.kind === 'main' || s.metadata(`chief-main-context:${this.homeId}`) === context.id)
      return '管家主对话上下文持续保留';
    if (context.routineId && s.get('routines', context.routineId))
      return '请先在例行工作中删除对应规则';
    const ownedRooms = new Set(parts.map((part) => part.conversationId));
    if (
      s
        .all<ChiefContextPart>('chief_parts')
        .some((part) => ownedRooms.has(part.conversationId) && part.contextId !== context.id)
    )
      return '上下文与其他工作共用会话，暂不能删除';
    const related = this.relatedTasks(tasks, parts);
    if (related.some((task) => !terminal(task.status))) return '请先完成或停止该工作及关联任务';
    if (related.some((task) => task.reconciliationRequired)) return '请先核查并对账尚未确认的操作';
    for (const task of related) {
      for (const [table, statuses] of [
        ['processes', ['running', 'unknown']],
        ['runs', ['running', 'waiting_approval', 'waiting_input']],
        ['tool_operations', ['prepared', 'dispatched', 'unknown']],
        ['questions', ['pending']],
        ['approvals', ['pending']],
        ['task_waits', ['pending']],
      ] as const) {
        if (
          s
            .byField<{ status: string }>(table, 'taskId', task.id)
            .some((row) => (statuses as readonly string[]).includes(row.status))
        )
          return '请先完成待处理操作、问题或审批';
      }
    }
    return undefined;
  }

  private view(context: ChiefWorkContext): ChiefHistoryTaskView {
    const parts = this.parts(context);
    const tasks = this.tasks(parts);
    const latest = parts.find((part) => part.id === context.currentPartId) ?? parts.at(-1)!;
    const room = this.state.storage.get<Conversation>('conversations', latest.conversationId)!;
    const reason = this.blocked(context, parts, tasks);
    const timestamps = [
      context.createdAt,
      ...parts.map((part) => part.createdAt),
      ...tasks.map((task) => task.updatedAt),
    ];
    return {
      id: context.id,
      title: context.title,
      kind: context.kind ?? 'history',
      workspaceId: room.workspaceId,
      createdAt: context.createdAt,
      updatedAt: timestamps.sort().at(-1)!,
      partCount: parts.length,
      taskCount: tasks.length,
      activeTaskIds: this.relatedTasks(tasks, parts)
        .filter((task) => !terminal(task.status))
        .map((task) => task.id),
      deletable: !reason,
      ...(reason ? { deleteBlockedReason: reason } : {}),
    };
  }

  private instructions(
    context: ChiefWorkContext,
    part: ChiefContextPart,
    messages: Message[],
    tasks: Task[],
  ): ChiefHistoryInstruction[] {
    const s = this.state.storage;
    const selected = new Set([...(context.sourceMessageIds ?? []), ...part.sourceMessageIds]);
    const mapped = new Map<string, Set<string>>();
    const sources = (messageId: string) => {
      const origin = s.metadata<{ sourceTaskId?: string; sourceMessageIds?: string[] }>(
        `chief-work-source:${messageId}`,
      );
      if (!origin) return [messageId];
      const parent = origin.sourceTaskId ? s.get<Task>('tasks', origin.sourceTaskId) : undefined;
      return [
        ...new Set([
          ...(origin.sourceMessageIds ?? []),
          ...(parent?.sourceMessageId ? [parent.sourceMessageId] : []),
        ]),
      ];
    };
    for (const message of messages) for (const source of sources(message.id)) selected.add(source);
    const recentTasks = new Set(tasks.slice(-40).map((task) => task.id));
    for (const task of tasks) {
      const ids = [
        task.sourceMessageId,
        ...s
          .byField<{ messageId?: string }>('deliveries', 'taskId', task.id)
          .map((input) => input.messageId),
      ].filter((value): value is string => !!value);
      for (const id of ids)
        for (const source of sources(id)) {
          const linked = mapped.get(source) ?? new Set<string>();
          linked.add(task.id);
          mapped.set(source, linked);
          if (context.kind !== 'main' && recentTasks.has(task.id)) selected.add(source);
        }
    }
    return [...selected]
      .flatMap((id) => {
        const message = s.getMessage(id);
        const room = message && s.get<Conversation>('conversations', message.conversationId);
        if (
          !message ||
          message.authorType !== 'user' ||
          message.status !== 'committed' ||
          room?.purpose !== 'chief' ||
          room.kind !== 'private' ||
          room.chiefId !== this.state.settings().mainBotId ||
          (room.chiefHomeId && room.chiefHomeId !== this.homeId)
        )
          return [];
        const sourceContextId =
          room.chiefContextId ??
          (room.id === this.homeId
            ? s.metadata<string>(`chief-main-context:${this.homeId}`)
            : undefined);
        const sourceContext = sourceContextId
          ? s.get<ChiefWorkContext>('chief_contexts', sourceContextId)
          : undefined;
        return [
          {
            messageId: message.id,
            conversationId: message.conversationId,
            contextId: sourceContext?.id ?? context.id,
            contextTitle: sourceContext?.title ?? room.name,
            content: message.content,
            createdAt: message.createdAt,
            taskIds: [...(mapped.get(id) ?? [])],
          },
        ];
      })
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId),
      );
  }
}
