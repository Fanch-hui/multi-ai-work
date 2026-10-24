import { randomUUID } from 'node:crypto';
import type {
  ChiefContextPart,
  ChiefContextView,
  ChiefInput,
  ChiefSnapshot,
  ChiefWorkContext,
} from '../domain/chief-work.js';
import type { Conversation, Message, Task, Workspace } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import type { State } from './state.js';
import { required } from './errors.js';
import { accessibleArtifacts } from './tool-access.js';

export interface ChiefContextInput {
  kind?: ChiefWorkContext['kind'];
  sourceTaskId?: string;
  sourceMessageIds?: string[];
  title?: string;
  workspaceId?: string;
  legacyConversationId?: string;
  legacyTaskId?: string;
  routineId?: string;
  conversationId?: string;
}

export class ChiefContextService {
  constructor(private state: State) {}
  get homeId() {
    return this.state.settings().mainConversationId!;
  }
  main() {
    return this.current(this.ensureMain().id);
  }
  ensureMain(): ChiefContextView {
    const s = this.state.storage;
    const key = `chief-main-context:${this.homeId}`;
    const saved = s.metadata<string>(key);
    const existing = this.list().find((item) => item.id === saved && item.kind === 'main');
    if (existing) return existing;
    return s.transaction(() => {
      const main = this.create({
        kind: 'main',
        title: '管家主对话',
        workspaceId: this.state.settings().defaultWorkspaceId,
      });
      const timeline = s.byField<import('../domain/chief-work.js').ChiefTimelineEntry>(
        'chief_timeline',
        'homeConversationId',
        this.homeId,
      );
      const originals = timeline.length
        ? timeline
            .sort((a, b) => a.displaySequence - b.displaySequence)
            .flatMap((entry) => {
              const message = s.getMessage(entry.messageId);
              return message?.status === 'committed' ? [message] : [];
            })
        : s.messages(this.homeId).filter((message) => message.status === 'committed');
      const recent = originals.filter((message) => message.authorType !== 'system').slice(-24);
      const part = this.current(main.id).part;
      s.put('chief_parts', {
        ...part,
        handoff: recent.length
          ? '继续同一管家主对话。以下原文来自此前的统一时间线，按显示顺序排列；用户的追问和补充自然接续。更早内容可通过历史检索展开。'
          : undefined,
        sourceMessageIds: recent.map((message) => message.id),
      });
      s.setMetadata(key, main.id);
      return main;
    });
  }
  current(contextId: string) {
    const s = this.state.storage;
    const context = required(s.get<ChiefWorkContext>('chief_contexts', contextId), '事项不存在');
    if (context.homeConversationId !== this.homeId) throw new Error('事项不在当前管家中');
    const part = required(
      s.get<ChiefContextPart>('chief_parts', context.currentPartId),
      '工作段不存在',
    );
    const room = required(
      s.get<Conversation>('conversations', part.conversationId),
      '工作会话不存在',
    );
    return { context, part, room };
  }
  list(): ChiefContextView[] {
    const s = this.state.storage;
    return s
      .byField<ChiefWorkContext>('chief_contexts', 'homeConversationId', this.homeId)
      .flatMap((context) => {
        const owned = s.byField<ChiefContextPart>('chief_parts', 'contextId', context.id);
        const current = owned.find((part) => part.id === context.currentPartId);
        const room = current && s.get<Conversation>('conversations', current.conversationId);
        if (!room || room.archived) return [];
        const conversationIds = owned.map((part) => part.conversationId);
        const tasks = conversationIds.flatMap((id) =>
          s.byField<Task>('tasks', 'conversationId', id),
        );
        return [
          {
            ...context,
            conversationIds,
            conversationId: room.id,
            workspaceId: room.workspaceId,
            activeTaskIds: tasks
              .filter(
                (task) =>
                  !task.kind &&
                  !terminal(task.status) &&
                  conversationIds.includes(task.conversationId),
              )
              .map((task) => task.id),
          },
        ];
      });
  }
  focus() {
    const s = this.state.storage;
    const focus = s.metadata<{ contextId?: string; revision: number; inputSequence?: number }>(
      `chief-focus:${this.homeId}`,
    );
    const context = focus?.contextId
      ? s.get<ChiefWorkContext>('chief_contexts', focus.contextId)
      : undefined;
    const part = context && s.get<ChiefContextPart>('chief_parts', context.currentPartId);
    const room = part && s.get<Conversation>('conversations', part.conversationId);
    return {
      contextId:
        context?.homeConversationId === this.homeId && room && !room.archived
          ? focus?.contextId
          : undefined,
      revision: focus?.revision ?? 0,
      inputSequence: focus?.inputSequence ?? 0,
    };
  }
  activate(contextId: string) {
    this.current(contextId);
    this.state.storage.setMetadata(`chief-focus:${this.homeId}`, {
      contextId,
      revision: this.focus().revision + 1,
    });
    this.state.changed();
    return this.list().find((item) => item.id === contextId)!;
  }
  create(input: ChiefContextInput = {}): ChiefContextView {
    const s = this.state.storage;
    const home = required(s.get<Conversation>('conversations', this.homeId), '管家主对话不存在');
    const legacy = input.legacyConversationId
      ? required(s.get<Conversation>('conversations', input.legacyConversationId), '历史对话不存在')
      : undefined;
    if (
      legacy &&
      (legacy.purpose !== 'chief' ||
        legacy.chiefId !== home.chiefId ||
        legacy.kind !== 'private' ||
        legacy.chiefRole === 'router')
    )
      throw new Error('只能续接管家自己的历史');
    const legacyTask = input.legacyTaskId
      ? required(s.get<Task>('tasks', input.legacyTaskId), '历史任务不存在')
      : undefined;
    if (legacyTask && legacyTask.conversationId !== legacy?.id)
      throw new Error('历史任务不属于该对话');
    const workspaceId =
      input.workspaceId ??
      legacy?.workspaceId ??
      this.state.settings().defaultWorkspaceId ??
      home.workspaceId;
    required(s.get<Workspace>('workspaces', workspaceId), '工作目录不存在');
    const title =
      (input.title ?? legacyTask?.goal ?? legacy?.name ?? '新事项').trim().slice(0, 120) ||
      '新事项';
    const contextId = randomUUID();
    const createdAt = new Date().toISOString();
    s.transaction(() => {
      const room = input.conversationId
        ? required(s.get<Conversation>('conversations', input.conversationId), '工作会话不存在')
        : {
            id: randomUUID(),
            name: title,
            kind: 'private' as const,
            purpose: 'chief' as const,
            chiefId: home.chiefId,
            memberIds: home.memberIds,
            workspaceId,
            createdAt,
          };
      const part: ChiefContextPart = {
        id: randomUUID(),
        contextId,
        conversationId: room.id,
        sourceMessageIds: input.sourceMessageIds ?? [],
        sourceArtifactIds: [],
        createdAt,
      };
      if (legacy && room.id !== legacy.id) {
        const messages = s
          .messages(legacy.id)
          .filter(
            (message) =>
              message.status === 'committed' &&
              (!legacyTask ||
                message.id === legacyTask.sourceMessageId ||
                (message.runId && legacyTask.runIds.includes(message.runId))),
          );
        part.sourceMessageIds = messages.slice(-8).map((message) => message.id);
        const references = new Set([
          ...(legacyTask?.artifactIds ?? []),
          ...(legacyTask?.inputArtifactIds ?? []),
          ...messages.slice(-8).flatMap((message) => message.artifactIds),
          ...(legacyTask
            ? (s.metadata<string[]>(`returned-artifacts:${legacyTask.id}`) ?? [])
            : []),
          ...(legacyTask
            ? (s.metadata<{ artifactIds: string[] }[]>(`results:${legacyTask.id}`) ?? []).flatMap(
                (result) => result.artifactIds,
              )
            : []),
        ]);
        part.sourceArtifactIds = accessibleArtifacts(this.state, legacy, home.chiefId!, legacyTask)
          .filter((artifact) => references.has(artifact.id))
          .map((artifact) => artifact.id);
        part.handoff = legacyTask
          ? `此前任务：${legacyTask.goal}\n结果：${legacyTask.result ?? legacyTask.status}`
          : `继续历史对话：${legacy.name}`;
      }
      let chiefRole: Conversation['chiefRole'] = input.routineId ? 'routine' : 'work';
      if (input.kind === 'main') chiefRole = 'main';
      if (room.id === this.homeId) chiefRole = 'home';
      s.put('conversations', {
        ...room,
        chiefRole,
        chiefHomeId: this.homeId,
        chiefContextId: contextId,
      });
      s.put('chief_parts', part);
      for (const artifactId of part.sourceArtifactIds) {
        const artifact = s.get<import('../domain/types.js').Artifact>('artifacts', artifactId);
        if (artifact && (!artifact.chiefContextId || artifact.chiefContextId === contextId))
          s.put('artifacts', { ...artifact, chiefContextId: contextId });
      }
      s.put<ChiefWorkContext>('chief_contexts', {
        kind: input.kind,
        sourceTaskId: input.sourceTaskId,
        sourceMessageIds: input.sourceMessageIds,
        id: contextId,
        homeConversationId: this.homeId,
        title,
        currentPartId: part.id,
        legacyConversationId: legacy?.id,
        legacyTaskId: legacyTask?.id,
        routineId: input.routineId,
        createdAt,
      });
    });
    this.state.changed();
    return this.list().find((item) => item.id === contextId)!;
  }
  rotate(
    contextId: string,
    handoff: string,
    sourceMessageIds: string[],
    sourceArtifactIds: string[],
  ): ChiefContextView {
    const s = this.state.storage;
    s.transaction(() => {
      const { context, part, room } = this.current(contextId);
      const rooms = new Set(this.list().find((item) => item.id === contextId)!.conversationIds);
      if (
        s
          .all<Task>('tasks')
          .some((task) => rooms.has(task.conversationId) && !task.kind && !terminal(task.status))
      )
        throw new Error('事项仍有未结束任务');
      let chiefRole: Conversation['chiefRole'] = 'work';
      if (context.kind === 'main') chiefRole = 'main';
      else if (room.chiefRole === 'routine') chiefRole = 'routine';
      const fresh: Conversation = {
        id: randomUUID(),
        name: context.title,
        kind: 'private',
        purpose: 'chief',
        memberIds: room.memberIds,
        chiefId: room.chiefId,
        workspaceId: room.workspaceId,
        chiefRole,
        chiefHomeId: this.homeId,
        chiefContextId: contextId,
        createdAt: new Date().toISOString(),
      };
      const next: ChiefContextPart = {
        id: randomUUID(),
        contextId,
        conversationId: fresh.id,
        previousPartId: part.id,
        handoff,
        sourceMessageIds,
        sourceArtifactIds,
        createdAt: fresh.createdAt,
      };
      s.put('conversations', fresh);
      s.put('chief_parts', next);
      s.put('chief_contexts', { ...context, currentPartId: next.id });
    });
    this.state.changed();
    return this.list().find((item) => item.id === contextId)!;
  }
}

export function chiefPartPrompt(state: State, room: Conversation): string {
  const s = state.storage;
  const part = s.firstByField<ChiefContextPart>('chief_parts', 'conversationId', room.id);
  if (!part?.handoff) return '';
  const messages = part.sourceMessageIds
    .map((id) => s.getMessage(id))
    .filter((message): message is Message => !!message);
  return `[事项交接资料]\n${part.handoff}\n近期原始消息：\n${messages.map((message) => `[${message.id}] ${message.authorType}: ${message.content.slice(0, 4000)}`).join('\n')}\n原记录保持保存。需要确切细节时使用 recall_work/read_work_history。`;
}

export function chiefSnapshot(state: State): ChiefSnapshot {
  const contexts = new ChiefContextService(state);
  return {
    homeConversationId: contexts.homeId,
    mainContextId: state.storage.metadata<string>(`chief-main-context:${contexts.homeId}`),
    focusContextId:
      state.storage.metadata<string>(`chief-main-context:${contexts.homeId}`) ??
      contexts.focus().contextId,
    contexts: contexts.list(),
    inputs: state.storage
      .byField<ChiefInput>('chief_inputs', 'homeConversationId', contexts.homeId)
      .filter(
        (input) =>
          input.homeConversationId === contexts.homeId &&
          input.status !== 'cancelled' &&
          (input.status !== 'dispatched' ||
            input.taskIds.some((taskId) => {
              const task = state.storage.get<Task>('tasks', taskId);
              return task && ['failed', 'interrupted', 'cancelled'].includes(task.status);
            })),
      ),
  };
}
