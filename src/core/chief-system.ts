import { z } from 'zod';
import type { State } from './state.js';
import type { TaskService } from './tasks.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Bot, Conversation } from '../domain/types.js';
import { conversationReferenceSchema } from '../domain/conversation-reference.js';
import { ChiefContextService } from './chief-contexts.js';
import { ChiefTimelineService } from './chief-timeline.js';
import { ChiefHistoryService } from './chief-history.js';
import { ChiefJobs } from './chief-jobs.js';
import { ChiefRoutingService } from './chief-routing.js';
import { ChiefMaintenanceService } from './chief-maintenance.js';
import { queueContextCompaction } from './conversation-compaction.js';
import { required } from './errors.js';
import { ATTACHMENT_LIMIT_MESSAGE } from '../domain/attachment-policy.js';
import { ChiefWorkService } from './chief-work-service.js';

const sendSchema = z.object({
  content: z.string().max(100000),
  artifactIds: z.array(z.string()).max(10, ATTACHMENT_LIMIT_MESSAGE).optional(),
  requestId: z.string().optional(),
  targetContextId: z.string().optional(),
  workspaceId: z.string().optional(),
  newContext: z.boolean().optional(),
  replyToMessageId: z.string().optional(),
  references: z.array(conversationReferenceSchema).max(12).optional(),
});
const searchSchema = z.object({
  query: z.string().max(100000).optional(),
  contextId: z.string().optional(),
  workspaceId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(40).optional(),
});

export class ChiefSystem {
  readonly contexts: ChiefContextService;
  readonly timeline: ChiefTimelineService;
  readonly history: ChiefHistoryService;
  readonly jobs: ChiefJobs;
  readonly routing: ChiefRoutingService;
  readonly work: ChiefWorkService;
  private maintenance: ChiefMaintenanceService;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private closed = true;
  constructor(
    private state: State,
    tasks: TaskService,
    cancelTask: (id: string) => Promise<unknown>,
  ) {
    this.contexts = new ChiefContextService(state);
    this.timeline = new ChiefTimelineService(state);
    this.history = new ChiefHistoryService(state);
    this.jobs = new ChiefJobs(state, tasks);
    this.routing = new ChiefRoutingService(state, tasks, this.contexts, cancelTask);
    this.work = new ChiefWorkService(state, tasks, this.contexts);
    this.maintenance = new ChiefMaintenanceService(state, this.contexts, {
      queue: this.jobs.queue.bind(this.jobs),
      compact: (id) => queueContextCompaction(state, tasks, id),
    });
  }
  start() {
    this.closed = false;
    this.routing.start();
    this.work.startReports();
    this.maintenance.start();
    this.unsubscribe = this.state.subscribe(() => this.scheduleHistory());
    this.scheduleHistory();
  }
  close() {
    this.closed = true;
    this.routing.close();
    this.work.closeReports();
    this.maintenance.close();
    this.unsubscribe?.();
    if (this.historyTimer) clearTimeout(this.historyTimer);
  }
  private scheduleHistory() {
    if (this.closed || this.historyTimer) return;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = undefined;
      if (!this.closed && this.history.sync()) this.scheduleHistory();
    }, 25);
    this.historyTimer.unref?.();
  }
  handles(method: string, params: Record<string, unknown>) {
    return (
      method.startsWith('chief.inputs.') ||
      method.startsWith('chief.contexts.') ||
      method.startsWith('chief.history.') ||
      method.startsWith('chief.timeline.') ||
      method === 'chief.conversations.create' ||
      (method === 'conversations.send' && params.conversationId === this.contexts.homeId)
    );
  }
  async request(method: string, params: Record<string, unknown>) {
    const id = () => z.string().parse(params.id);
    switch (method) {
      case 'chief.inputs.send':
      case 'conversations.send':
        return this.routing.send(sendSchema.parse(params));
      case 'chief.inputs.resolve':
        return this.routing.resolve(
          id(),
          z
            .object({
              contextId: z.string().optional(),
              workspaceId: z.string().optional(),
              newContext: z.boolean().optional(),
              answer: z.string().max(5000).optional(),
            })
            .parse(params),
        );
      case 'chief.inputs.retry':
        return this.routing.retry(id());
      case 'chief.inputs.cancel':
        return this.routing.cancel(id());
      case 'chief.contexts.list':
        return this.contexts.list();
      case 'chief.contexts.activate':
        return this.contexts.activate(id());
      case 'chief.contexts.create': {
        const context = this.contexts.create(
          z
            .object({
              title: z.string().max(120).optional(),
              workspaceId: z.string().optional(),
              legacyConversationId: z.string().optional(),
              legacyTaskId: z.string().optional(),
            })
            .parse(params),
        );
        this.contexts.activate(context.id);
        return context;
      }
      case 'chief.conversations.create': {
        const bot = required(
          this.state.storage.get<Bot>('bots', this.state.settings().mainBotId!),
          '管家不存在',
        );
        if (
          (params.model !== undefined && params.model !== bot.model) ||
          (params.reasoning !== undefined && params.reasoning !== bot.reasoning)
        )
          throw new Error('请在管家配置中统一设置模型和推理强度');
        const context = this.contexts.create({
          title: z.string().max(120).optional().parse(params.name),
          workspaceId: z.string().optional().parse(params.workspaceId),
        });
        this.contexts.activate(context.id);
        return this.state.storage.get<Conversation>('conversations', this.contexts.homeId);
      }
      case 'chief.history.search':
        return this.history.search(searchSchema.parse(params));
      case 'chief.history.read':
        return this.history.read(
          z
            .object({ messageId: z.string(), limit: z.number().int().min(1).max(40).optional() })
            .parse(params),
        );
      case 'chief.timeline.page':
        return this.timeline.page(
          z.number().int().positive().optional().parse(params.before),
          z.number().int().min(1).max(200).optional().parse(params.limit),
        );
      case 'chief.timeline.read': {
        if (this.timeline.read(z.array(z.string()).max(200).parse(params.messageIds)))
          this.state.changed('state', { incremental: true });
        return { ok: true };
      }
      default:
        throw new Error('不支持的管家操作');
    }
  }
  toolHistory(
    action: 'search' | 'read',
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    if (
      context.botId !== this.state.settings().mainBotId ||
      context.conversation.kind !== 'private' ||
      context.conversation.purpose !== 'chief' ||
      context.conversation.chiefHomeId !== this.contexts.homeId
    )
      throw new Error('历史召回仅供管家直属私聊使用');
    const result =
      action === 'search'
        ? this.history.search(searchSchema.parse(args))
        : this.history.read(
            z
              .object({ messageId: z.string(), limit: z.number().int().min(1).max(40).optional() })
              .parse(args),
          );
    const hits = 'items' in result ? result.items : result.messages;
    const messageKey = `chief-message-grants:${context.conversation.id}`;
    this.state.storage.setMetadata(messageKey, [
      ...new Set([
        ...(this.state.storage.metadata<string[]>(messageKey) ?? []),
        ...hits.map((hit) => hit.messageId),
      ]),
    ]);
    const taskIds = hits.flatMap((hit) => (hit.taskId ? [hit.taskId] : []));
    if (taskIds.length) {
      const key = `chief-task-grants:${context.conversation.id}`;
      this.state.storage.setMetadata(key, [
        ...new Set([...(this.state.storage.metadata<string[]>(key) ?? []), ...taskIds]),
      ]);
    }
    const ids = hits.flatMap((hit) => hit.artifactIds);
    if (ids.length) {
      const key = `chief-artifact-grants:${context.conversation.id}`;
      this.state.storage.setMetadata(key, [
        ...new Set([...(this.state.storage.metadata<string[]>(key) ?? []), ...ids]),
      ]);
    }
    return result;
  }
}
