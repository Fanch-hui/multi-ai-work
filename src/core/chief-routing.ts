import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChiefInput, ChiefRouteDecision, ChiefTimelineEntry } from '../domain/chief-work.js';
import type { Artifact, Conversation, Task } from '../domain/types.js';
import type { ConversationReference } from '../domain/conversation-reference.js';
import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import type { ChiefJobs } from './chief-jobs.js';
import type { ChiefHistoryService } from './chief-history.js';
import { ChiefContextService } from './chief-contexts.js';
import { ChiefTimelineService } from './chief-timeline.js';
import { chiefRoutingPrompt } from './chief-routing-prompt.js';
import { terminal } from '../domain/task-status.js';
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
const decisionSchema = z.object({
  action: z.enum(['continue', 'new', 'clarify']),
  contextId: z.string().optional(),
  workspaceId: z.string().optional(),
  legacyConversationId: z.string().optional(),
  legacyTaskId: z.string().optional(),
  title: z.string().max(120).optional(),
  question: z.string().max(500).optional(),
  candidateContextIds: z.array(z.string()).max(8).optional(),
});

export class ChiefRoutingService {
  private unsubscribe?: () => void;
  private scheduled = false;
  private stopped = true;
  constructor(
    private state: State,
    private tasks: TaskService,
    readonly contexts: ChiefContextService,
    private jobs: ChiefJobs,
    private history: ChiefHistoryService,
    private cancelTask: (id: string) => Promise<unknown>,
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
    if (fields.workspaceId) required(s.get('workspaces', fields.workspaceId), '项目不存在');
    for (const id of artifactIds) {
      const artifact = required(s.get<Artifact>('artifacts', id), '资料不存在');
      const allowed = [this.contexts.homeId, target?.room.id, target?.context.legacyConversationId];
      if (!allowed.includes(artifact.conversationId))
        throw new Error('附件不在当前管家草稿或指定历史中');
    }
    if (fields.replyToMessageId) this.replyContext(fields.replyToMessageId);
    const requestId = fields.requestId ?? randomUUID();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...fields, content, artifactIds, requestId: undefined }))
      .digest('hex');
    const previous = s.firstByField<ChiefInput>('chief_inputs', 'requestId', requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('消息请求 ID 与内容不匹配');
      return { inputId: previous.id, messageId: previous.messageId, taskIds: previous.taskIds };
    }
    const focus = this.contexts.focus();
    const input: ChiefInput = {
      ...fields,
      id: randomUUID(),
      homeConversationId: this.contexts.homeId,
      messageId: randomUUID(),
      requestId,
      fingerprint,
      content,
      artifactIds,
      focusContextId: focus.contextId,
      focusRevision: focus.revision,
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
    const saved = s.get<ChiefInput>('chief_inputs', input.id)!;
    return { inputId: saved.id, messageId: saved.messageId, taskIds: saved.taskIds };
  }
  resolve(
    id: string,
    fields: { contextId?: string; workspaceId?: string; newContext?: boolean; answer?: string },
  ) {
    const input = this.input(id);
    if (input.status !== 'clarification') throw new Error('该输入没有待处理的归属问题');
    if (fields.contextId) this.contexts.current(fields.contextId);
    this.state.storage.put('chief_inputs', {
      ...input,
      targetContextId: fields.contextId,
      workspaceId: fields.workspaceId ?? input.workspaceId,
      newContext: fields.newContext,
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
    if (input.routingTaskId) await this.cancelTask(input.routingTaskId);
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
    const inputs = this.state.storage.byField<ChiefInput>(
      'chief_inputs',
      'homeConversationId',
      this.contexts.homeId,
    );
    for (const input of inputs.filter((input) => input.status === 'routing')) {
      const job = input.routingTaskId && this.state.storage.get<Task>('tasks', input.routingTaskId);
      if (!job || !terminal(job.status)) return;
      try {
        if (job.status !== 'completed') throw new Error(job.error ?? '事项识别已中断，请重试');
        const json = job.result?.match(/\{[\s\S]*\}/)?.[0];
        const decision = decisionSchema.parse(JSON.parse(json ?? ''));
        this.apply(input, decision);
      } catch (error) {
        this.fail(input, error);
      }
    }
    for (const input of inputs.filter((input) => input.status === 'pending')) {
      this.process(this.input(input.id));
      if (this.input(input.id).status === 'routing') break;
    }
  }
  private process(input: ChiefInput) {
    try {
      if (input.targetContextId) return this.dispatch(input, input.targetContextId);
      if (input.newContext)
        return this.apply(input, {
          action: 'new',
          title: input.content?.slice(0, 40),
          workspaceId: input.workspaceId,
        });
      if (input.replyToMessageId) {
        const source = this.replyContext(input.replyToMessageId);
        if (source.contextId) return this.dispatch(input, source.contextId);
        return this.apply(input, { action: 'new', legacyConversationId: source.room.id });
      }
      if (
        input.focusContextId &&
        /^(继续|好的|好|可以|按这个做|继续吧|接着做|就这样做)[。！!\s]*$/.test(input.content ?? '')
      )
        return this.dispatch(input, input.focusContextId);
      const attempt = (input.attempt ?? 0) + 1;
      const job = this.jobs.queue(
        'chief-routing',
        chiefRoutingPrompt(this.state, this.contexts, this.history, input),
        `chief-route:${input.id}:${attempt}`,
      );
      this.state.storage.put('chief_inputs', {
        ...input,
        status: 'routing',
        routingTaskId: job.id,
        attempt,
      });
      this.state.changed();
    } catch (error) {
      this.fail(input, error);
    }
  }
  private apply(input: ChiefInput, decision: ChiefRouteDecision) {
    if (decision.action === 'clarify') {
      const candidates = decision.candidateContextIds ?? [];
      for (const id of candidates) this.contexts.current(id);
      this.state.storage.put('chief_inputs', {
        ...input,
        status: 'clarification',
        question: decision.question ?? '这条消息对应哪个事项？',
        candidateContextIds: candidates,
      });
      this.state.changed();
      return;
    }
    if (decision.action === 'continue')
      return this.dispatch(input, required(decision.contextId, '缺少目标事项'));
    if (decision.legacyConversationId && !input.replyToMessageId) {
      const hits =
        this.state.storage.metadata<{ conversationId: string; taskId?: string }[]>(
          `chief-route-history:${input.id}`,
        ) ?? [];
      if (
        !hits.some(
          (hit) =>
            hit.conversationId === decision.legacyConversationId &&
            (!decision.legacyTaskId || hit.taskId === decision.legacyTaskId),
        )
      )
        throw new Error('历史任务不在本次候选中');
    }
    const focus = this.contexts.list().find((item) => item.id === input.focusContextId);
    this.state.storage.transaction(() => {
      const context = this.contexts.create({
        title: decision.title ?? input.content?.slice(0, 40),
        workspaceId: input.workspaceId ?? decision.workspaceId ?? focus?.workspaceId,
        legacyConversationId: decision.legacyConversationId,
        legacyTaskId: decision.legacyTaskId,
      });
      this.dispatch(input, context.id);
    });
  }
  private dispatch(input: ChiefInput, contextId: string) {
    const s = this.state.storage;
    const maintenance = s.metadata<{ status?: string }>(`chief-maintenance:${contextId}`);
    if (maintenance && ['judging', 'compacting'].includes(maintenance.status ?? '')) return;
    s.transaction(() => {
      const { room, part } = this.contexts.current(contextId);
      const current = this.input(input.id);
      if (!['pending', 'routing'].includes(current.status)) return;
      s.put('chief_inputs', { ...current, contextId, status: 'routing' });
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
        content: input.content!,
        artifactIds: input.artifactIds,
        requestId: `chief-input:${input.id}`,
        messageId: input.messageId,
        chiefInputId: input.id,
        replyToMessageId: input.replyToMessageId,
        references: input.references,
      });
      s.put('chief_inputs', {
        ...current,
        contextId,
        status: 'dispatched',
        taskIds: result.taskIds,
        content: undefined,
        error: undefined,
      });
      const focus = this.contexts.focus();
      const sequence = s.get<ChiefTimelineEntry>(
        'chief_timeline',
        input.messageId,
      )!.displaySequence;
      if (focus.revision === (input.focusRevision ?? 0) && sequence >= focus.inputSequence)
        s.setMetadata(`chief-focus:${this.contexts.homeId}`, {
          contextId,
          revision: focus.revision,
          inputSequence: sequence,
        });
    });
    this.state.changed();
  }
  private replyContext(messageId: string) {
    const s = this.state.storage;
    const message = required(s.getMessage(messageId), '引用消息不存在');
    const room = required(
      s.get<Conversation>('conversations', message.conversationId),
      '引用对话不存在',
    );
    if (
      room.purpose !== 'chief' ||
      room.kind !== 'private' ||
      room.chiefId !== this.state.settings().mainBotId ||
      room.chiefRole === 'router'
    )
      throw new Error('引用不属于管家历史');
    const contextId = this.contexts
      .list()
      .find((item) => item.conversationIds.includes(room.id))?.id;
    return { room, contextId };
  }
  private fail(input: ChiefInput, error: unknown) {
    this.state.storage.put('chief_inputs', {
      ...this.input(input.id),
      status: 'failed',
      error: error instanceof Error ? error.message : '事项识别失败',
    });
    this.state.changed();
  }
}
