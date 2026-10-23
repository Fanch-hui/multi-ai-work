import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorDraft, ConnectorDraftView } from '../domain/connector-drafts.js';
import type { ToolExecutionContext, ToolRegistry } from '../domain/tools.js';
import type { Bot, Task, ToolConnection } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import {
  assertDraftContext,
  connectorConfiguration,
  draftConnection,
  draftSendBlockedReason,
  draftFieldSchema,
  validateDraftArguments,
} from './connector-draft-policy.js';
import { publicError, required } from './errors.js';
import { State, now } from './state.js';
import type { TaskService } from './tasks.js';

const objectId = z.string().trim().min(1).max(200);
const argumentsSchema = z.record(z.string(), z.unknown());
const createSchema = z.object({
  connectionId: objectId,
  toolName: objectId,
  title: z.string().trim().min(1).max(200),
  arguments: argumentsSchema,
  fields: z.array(draftFieldSchema).min(2).max(30),
  requestId: objectId.optional(),
});

export class ConnectorDrafts {
  private sending = new Set<string>();
  constructor(
    private state: State,
    private tasks: TaskService,
    private registry: ToolRegistry,
  ) {}

  request(method: string, params: Record<string, unknown>): unknown {
    if (method === 'connectorDrafts.list') {
      const conversationId = objectId.optional().parse(params.conversationId);
      return this.state.storage
        .all<ConnectorDraft>('connector_drafts')
        .filter((draft) => !conversationId || draft.conversationId === conversationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((draft) => this.view(draft));
    }
    const draft = this.get(objectId.parse(params.id));
    if (method === 'connectorDrafts.get') return this.view(draft);
    if (method === 'connectorDrafts.update') {
      this.requireRevision(draft, params.revision);
      if (!['draft', 'failed'].includes(draft.status)) throw new Error('此草稿当前不可编辑');
      const args = argumentsSchema.parse(params.arguments);
      validateDraftArguments(args, draft.fields);
      return this.save({
        ...draft,
        arguments: args,
        status: 'draft',
        revision: draft.revision + 1,
        error: undefined,
      });
    }
    if (method === 'connectorDrafts.confirm') return this.confirm(draft, params);
    if (method === 'connectorDrafts.cancel') {
      this.requireRevision(draft, params.revision);
      if (!['draft', 'failed'].includes(draft.status)) throw new Error('此草稿当前不可取消');
      return this.save({ ...draft, status: 'cancelled' });
    }
    if (method === 'connectorDrafts.reconcile') {
      this.requireRevision(draft, params.revision);
      if (draft.status !== 'unknown') throw new Error('此草稿无需核查');
      const outcome = z.enum(['sent', 'not_sent']).parse(params.outcome);
      const note = z.string().trim().min(1).max(2000).parse(params.note);
      return this.save({
        ...draft,
        status: outcome === 'sent' ? 'sent' : 'draft',
        revision: draft.revision + 1,
        confirmedRevision: undefined,
        dispatchTaskId: undefined,
        result: `用户核查：${note}`,
        error: undefined,
      });
    }
    throw new Error('未知草稿操作');
  }

  execute(
    action: 'create' | 'send' | 'get',
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): unknown {
    if (action === 'create') return this.create(args, context);
    const draft = this.get(objectId.parse(args.id));
    assertDraftContext(this.state, draft, context);
    if (action === 'get') return this.view(draft);
    return this.send(draft, context);
  }

  recover() {
    for (const draft of this.state.storage.all<ConnectorDraft>('connector_drafts')) {
      if (draft.status === 'sending')
        this.save({ ...draft, status: 'unknown', error: '应用在发送过程中退出，请先核查外部结果' });
    }
  }

  private create(args: Record<string, unknown>, context: ToolExecutionContext) {
    context.signal.throwIfAborted();
    context.assertAuthorized?.();
    const input = createSchema.parse(args);
    validateDraftArguments(input.arguments, input.fields);
    const connection = draftConnection(
      this.state,
      context.botId,
      context.conversation.id,
      input.connectionId,
      input.toolName,
    );
    const requestId = `${context.task.id}:${input.requestId ?? context.callId ?? createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
    const creationFingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.state.storage.firstByField<ConnectorDraft>(
      'connector_drafts',
      'requestId',
      requestId,
    );
    if (existing) {
      if (existing.creationFingerprint !== creationFingerprint || existing.botId !== context.botId)
        throw new Error('草稿请求 ID 与内容不匹配');
      return this.view(existing);
    }
    const timestamp = now();
    const draft: ConnectorDraft = {
      ...input,
      id: createHash('sha256').update(requestId).digest('hex'),
      requestId,
      creationFingerprint,
      conversationId: context.conversation.id,
      sourceTaskId: context.task.id,
      botId: context.botId,
      connectionConfiguration: connectorConfiguration(this.state, connection),
      revision: 1,
      status: 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.save(draft);
  }

  private confirm(draft: ConnectorDraft, params: Record<string, unknown>) {
    this.requireRevision(draft, params.revision);
    if (['sent', 'sending', 'unknown', 'cancelled'].includes(draft.status))
      throw new Error('此草稿当前不可发送');
    const blocked = draftSendBlockedReason(this.state, draft.botId);
    if (blocked) throw new Error(blocked);
    const connection = draftConnection(
      this.state,
      draft.botId,
      draft.conversationId,
      draft.connectionId,
      draft.toolName,
    );
    if (connectorConfiguration(this.state, connection) !== draft.connectionConfiguration)
      throw new Error('连接器配置已更改，请重新创建草稿');
    const dispatch =
      draft.dispatchTaskId && this.state.storage.get<Task>('tasks', draft.dispatchTaskId);
    if (draft.status === 'approved' && dispatch && !terminal(dispatch.status))
      return this.view(draft);
    validateDraftArguments(draft.arguments, draft.fields);
    const requestId = objectId.parse(params.requestId);
    let saved!: ConnectorDraft;
    this.state.storage.db.transaction(() => {
      const task = this.tasks.create({
        conversationId: draft.conversationId,
        botId: draft.botId,
        requestId: `connector-draft:${draft.id}:${draft.revision}:${requestId}`,
        goal: `用户已确认外发草稿“${draft.title}”（ID: ${draft.id}，版本 ${draft.revision}）。请调用 send_connector_draft，仅传入此 ID，发送已确认的内容并汇报实际结果。`,
        expectedOutput: '使用已确认草稿的固定参数完成发送，并汇报连接器返回的实际结果。',
      });
      saved = {
        ...draft,
        status: 'approved',
        confirmedRevision: draft.revision,
        confirmedAt: now(),
        dispatchTaskId: task.id,
        error: undefined,
        updatedAt: now(),
      };
      this.state.storage.put('connector_drafts', saved);
    })();
    this.state.changed();
    return this.view(saved);
  }

  private async send(draft: ConnectorDraft, context: ToolExecutionContext) {
    if (draft.status === 'sent') return { draftId: draft.id, status: 'sent', result: draft.result };
    if (draft.status !== 'approved' || draft.confirmedRevision !== draft.revision)
      throw new Error('请先由用户确认当前草稿版本');
    if (draft.dispatchTaskId !== context.task.id)
      throw new Error('请在草稿确认后创建的发送任务中执行');
    if (this.sending.has(draft.id)) throw new Error('草稿正在发送');
    this.sending.add(draft.id);
    let dispatched = false;
    const authorize = () => {
      const blocked = draftSendBlockedReason(this.state, draft.botId);
      if (blocked) throw new Error(blocked);
      const current = this.get(draft.id);
      if (!['approved', 'sending'].includes(current.status) || current.revision !== draft.revision)
        throw new Error('草稿版本或状态已变更');
      return assertDraftContext(this.state, current, context);
    };
    try {
      const connection = authorize();
      const result = await this.registry.execute(
        'call_mcp',
        { connectionId: draft.connectionId, toolName: draft.toolName, arguments: draft.arguments },
        {
          ...context,
          toolConnections: [connection],
          assertAuthorized: authorize,
          markDispatched: () => {
            authorize();
            dispatched = true;
            this.save({
              ...this.get(draft.id),
              status: 'sending',
              operationId: `${context.runId}:${context.callId}`,
            });
            context.markDispatched?.();
          },
          requestApproval: async (tool, summary, args) => {
            const approved = await context.requestApproval(tool, summary, args);
            authorize();
            return approved;
          },
        },
      );
      const failed = !!(
        result &&
        typeof result === 'object' &&
        'isError' in result &&
        result.isError
      );
      const summary = JSON.stringify(result)?.slice(0, 20_000) ?? '';
      const saved = this.save({
        ...this.get(draft.id),
        status: failed ? 'failed' : 'sent',
        result: summary,
        error: failed ? '连接器返回发送失败，请查看结果' : undefined,
      });
      return { draftId: saved.id, status: saved.status, result };
    } catch (error) {
      this.save({
        ...this.get(draft.id),
        status: dispatched ? 'unknown' : 'failed',
        error: publicError(error),
      });
      throw error;
    } finally {
      this.sending.delete(draft.id);
    }
  }

  private get(id: string) {
    return required(this.state.storage.get<ConnectorDraft>('connector_drafts', id), '草稿不存在');
  }
  private requireRevision(draft: ConnectorDraft, revision: unknown) {
    if (z.number().int().min(1).parse(revision) !== draft.revision)
      throw new Error('草稿已更新，请重新查看后操作');
  }
  private save(draft: ConnectorDraft): ConnectorDraftView {
    const updated = { ...draft, updatedAt: now() };
    this.state.storage.put('connector_drafts', updated);
    this.state.changed();
    return this.view(updated);
  }
  private view(draft: ConnectorDraft): ConnectorDraftView {
    const { connectionConfiguration: _configuration, ...visible } = draft;
    return {
      ...visible,
      connectionConfiguration: '',
      connectionName:
        this.state.storage.get<ToolConnection>('tool_connections', draft.connectionId)?.name ??
        '已删除连接器',
      botName: this.state.storage.get<Bot>('bots', draft.botId)?.name ?? '已删除成员',
      dispatchStatus: draft.dispatchTaskId
        ? this.state.storage.get<Task>('tasks', draft.dispatchTaskId)?.status
        : undefined,
      sendBlockedReason: draftSendBlockedReason(this.state, draft.botId),
    };
  }
}
