import { createHash, randomUUID } from 'node:crypto';
import type { ChiefInput } from '../domain/chief-work.js';
import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { ConversationReference } from '../domain/conversation-reference.js';
import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import type { ChiefJobs } from './chief-jobs.js';
import type { ChiefHistoryService } from './chief-history.js';
import { ChiefContextService } from './chief-contexts.js';
import { ChiefTimelineService } from './chief-timeline.js';
import { requireAttachmentCapacity } from '../domain/attachment-policy.js';
import { required } from './errors.js';

export interface ChiefSendInput {
  content: string;
  artifactIds?: string[];
  requestId?: string;
  targetContextId?: string;
  workspaceId?: string;
  newContext?: boolean;
  replyToMessageId?: string;
  references?: ConversationReference[];
}

export class ChiefRoutingService {
  private unsubscribe?: () => void;
  private scheduled = false;
  private stopped = true;
  private pumping = false;
  constructor(
    private state: State,
    private tasks: TaskService,
    readonly contexts: ChiefContextService,
    _jobs?: ChiefJobs,
    _history?: ChiefHistoryService,
    private cancelTask?: (id: string) => Promise<unknown>,
  ) {}
  start() {
    this.stopped = false;
    this.unsubscribe = this.state.subscribe(() => this.schedule());
    this.schedule();
  }
  close() {
    this.stopped = true;
    this.unsubscribe?.();
  }
  send(fields: ChiefSendInput) {
    const s = this.state.storage;
    const content = fields.content.trim() || (fields.artifactIds?.length ? '请阅读所附资料。' : '');
    if (!content || content.length > 100000) throw new Error('消息内容为空或过长');
    const artifactIds = [...new Set(fields.artifactIds ?? [])];
    requireAttachmentCapacity(0, artifactIds.length);
    const target = fields.targetContextId
      ? this.contexts.current(fields.targetContextId)
      : undefined;
    const reply = fields.replyToMessageId ? this.replySource(fields.replyToMessageId) : undefined;
    if (fields.workspaceId) required(s.get('workspaces', fields.workspaceId), '项目不存在');
    for (const id of artifactIds) {
      const artifact = required(s.get<Artifact>('artifacts', id), '资料不存在');
      const allowed = [
        this.contexts.homeId,
        target?.room.id,
        target?.context.legacyConversationId,
        reply?.id,
      ];
      if (!allowed.includes(artifact.conversationId))
        throw new Error('附件不在当前管家草稿或指定历史中');
    }
    const requestId = fields.requestId ?? randomUUID();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...fields, content, artifactIds, requestId: undefined }))
      .digest('hex');
    const previous = s.firstByField<ChiefInput>('chief_inputs', 'requestId', requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('消息请求 ID 与内容不匹配');
      return { inputId: previous.id, messageId: previous.messageId, taskIds: previous.taskIds };
    }
    const main = this.contexts.ensureMain();
    const input: ChiefInput = {
      ...fields,
      id: randomUUID(),
      homeConversationId: this.contexts.homeId,
      messageId: randomUUID(),
      requestId,
      fingerprint,
      content,
      artifactIds,
      focusContextId: main.id,
      status: 'pending',
      taskIds: [],
      createdAt: new Date().toISOString(),
    };
    s.transaction(() => {
      s.put('chief_inputs', input);
      new ChiefTimelineService(this.state).add(input.messageId, input.id);
    });
    this.pump();
    this.state.changed();
    const saved = this.input(input.id);
    return { inputId: saved.id, messageId: saved.messageId, taskIds: saved.taskIds };
  }
  resolve(
    id: string,
    fields: { contextId?: string; workspaceId?: string; newContext?: boolean; answer?: string },
  ) {
    const input = this.input(id);
    if (input.status !== 'clarification') throw new Error('该输入没有待处理的问题');
    if (fields.contextId) this.contexts.current(fields.contextId);
    this.state.storage.put('chief_inputs', {
      ...input,
      targetContextId: fields.contextId ?? input.targetContextId,
      workspaceId: fields.workspaceId ?? input.workspaceId,
      clarificationAnswer: fields.answer,
      status: 'pending',
      routingTaskId: undefined,
      error: undefined,
    });
    this.state.changed();
    this.schedule();
    return { ok: true };
  }
  retry(id: string) {
    const input = this.input(id);
    if (input.status === 'dispatched') {
      const failed = input.taskIds
        .map((taskId) => this.state.storage.get<Task>('tasks', taskId))
        .filter(
          (task): task is Task =>
            !!task && ['failed', 'cancelled', 'interrupted'].includes(task.status),
        );
      if (!failed.length) throw new Error('该消息没有可重试的任务');
      this.state.storage.transaction(() => {
        const replacements = new Map(failed.map((task) => [task.id, this.tasks.retry(task.id).id]));
        this.state.storage.put('chief_inputs', {
          ...input,
          taskIds: input.taskIds.map((taskId) => replacements.get(taskId) ?? taskId),
        });
      });
      this.state.changed();
      return { ok: true };
    }
    if (input.status !== 'failed') throw new Error('只有失败的输入可重试');
    this.state.storage.put('chief_inputs', {
      ...input,
      status: 'pending',
      routingTaskId: undefined,
      error: undefined,
    });
    this.state.changed();
    this.schedule();
    return { ok: true };
  }
  async cancel(id: string) {
    const input = this.input(id);
    if (input.status === 'dispatched') throw new Error('输入已派发，请在对应任务中停止');
    this.state.storage.put('chief_inputs', { ...input, status: 'cancelled' });
    this.state.changed();
    if (input.routingTaskId) await this.cancelTask?.(input.routingTaskId);
    return { cancelled: true };
  }
  private input(id: string) {
    const input = required(
      this.state.storage.get<ChiefInput>('chief_inputs', id),
      '管家输入不存在',
    );
    if (input.homeConversationId !== this.contexts.homeId) throw new Error('输入不属于当前管家');
    return input;
  }
  private schedule() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopped) this.pump();
    });
  }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const s = this.state.storage;
      const pending = s
        .byField<ChiefInput>('chief_inputs', 'homeConversationId', this.contexts.homeId)
        .filter((input) => input.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const input of pending) {
        try {
          if (!this.dispatch(input)) break;
        } catch (error) {
          s.put('chief_inputs', {
            ...this.input(input.id),
            status: 'failed',
            error: error instanceof Error ? error.message : '消息发送失败',
          });
          this.state.changed();
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private dispatch(input: ChiefInput) {
    const s = this.state.storage;
    const { context, room, part } = this.contexts.main();
    const maintenance = s.metadata<{ status?: string }>(`chief-maintenance:${context.id}`);
    if (maintenance && ['judging', 'compacting'].includes(maintenance.status ?? '')) return false;
    s.transaction(() => {
      const current = this.input(input.id);
      if (current.status !== 'pending') return;
      s.put('chief_inputs', { ...current, contextId: context.id, status: 'routing' });
      const key = `chief-artifact-grants:${room.id}`;
      s.setMetadata(key, [
        ...new Set([
          ...(s.metadata<string[]>(key) ?? []),
          ...input.artifactIds,
          ...part.sourceArtifactIds,
        ]),
      ]);
      const result = this.tasks.send({
        conversationId: room.id,
        content: input.clarificationAnswer
          ? `${input.content}\n${input.clarificationAnswer}`
          : input.content!,
        artifactIds: input.artifactIds,
        requestId: `chief-input:${input.id}`,
        messageId: input.messageId,
        chiefInputId: input.id,
        replyToMessageId: input.replyToMessageId,
        references: input.references,
      });
      s.put('chief_inputs', {
        ...current,
        contextId: context.id,
        status: 'dispatched',
        taskIds: result.taskIds,
        content: undefined,
        error: undefined,
      });
    });
    this.state.changed();
    return true;
  }
  private replySource(messageId: string) {
    const message = required(this.state.storage.getMessage(messageId), '引用消息不存在');
    if (message.status === 'draft') throw new Error('请选择已发表的消息');
    const room = required(
      this.state.storage.get<Conversation>('conversations', message.conversationId),
      '引用对话不存在',
    );
    if (
      room.purpose !== 'chief' ||
      room.kind !== 'private' ||
      room.chiefId !== this.state.settings().mainBotId ||
      room.chiefRole === 'router'
    )
      throw new Error('引用不属于管家历史');
    return room;
  }
}
