import { z } from 'zod';
import type { CollaborationRequest } from '../domain/collaboration.js';
import type { Artifact, Bot, Conversation, Task } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { State, id, now } from './state.js';
import { TaskService, terminal } from './tasks.js';
import { required } from './errors.js';

const requestSchema = z.object({
  targetBotId: z.string(),
  goal: z.string().trim().min(1).max(20000),
  expectedOutput: z.string().max(20000).default(''),
  artifactIds: z.array(z.string()).max(10).default([]),
});
export class CollaborationRequests {
  private unsubscribe?: () => void;
  private checking = false;
  private version = -1;
  constructor(
    private state: State,
    private tasks: TaskService,
  ) {}
  start() {
    this.close();
    this.version = -1;
    this.unsubscribe = this.state.subscribe((kind) => {
      if (kind === 'state') this.settle();
    });
    this.settle();
  }
  close() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  request(method: string, params: Record<string, unknown>) {
    if (method !== 'collaboration.list') throw new Error('不支持的协作操作');
    const conversationId = z.string().parse(params.conversationId);
    required(this.state.storage.get<Conversation>('conversations', conversationId), '会话不存在');
    return this.state.storage
      .byField<CollaborationRequest>('collaboration_requests', 'conversationId', conversationId)
      .map((request) => ({
        ...request,
        task: request.targetTaskId
          ? this.state.storage.get<Task>('tasks', request.targetTaskId)
          : undefined,
      }));
  }
  async create(args: Record<string, unknown>, context: ToolExecutionContext) {
    const input = requestSchema.parse(args);
    context.assertAuthorized?.();
    const s = this.state.storage;
    const room = required(
      s.get<Conversation>('conversations', context.conversation.id),
      '会话不存在',
    );
    const source = required(s.get<Task>('tasks', context.task.id), '任务不存在');
    const chiefId = this.state.settings().mainBotId;
    const target = required(s.get<Bot>('bots', input.targetBotId), '接收成员不存在');
    if (
      !chiefId ||
      !room.memberIds.includes(chiefId) ||
      room.archived ||
      !room.memberIds.includes(target.id) ||
      target.archived ||
      target.id === context.botId ||
      target.id === chiefId
    )
      throw new Error('请选择当前团队群中的其他成员，由主管统筹交接');
    if (source.botId !== context.botId || terminal(source.status))
      throw new Error('当前任务已结束');
    if (input.artifactIds.some((id) => !context.findArtifact(id)))
      throw new Error('协作资料未授权');
    const requestId = `${context.runId}:${context.callId}`;
    const previous = s.firstByField<CollaborationRequest>(
      'collaboration_requests',
      'requestId',
      requestId,
    );
    if (previous) return previous;
    if (
      !(await context.requestApproval('request_collaboration', `请求 ${target.name} 协作`, input))
    )
      throw new Error('协作请求未获批准');
    context.assertAuthorized?.();
    context.markDispatched?.();
    const request = s.transaction(() => {
      const currentRoom = required(s.get<Conversation>('conversations', room.id), '会话不存在');
      const currentTarget = required(s.get<Bot>('bots', target.id), '接收成员不存在');
      if (
        currentRoom.archived ||
        currentTarget.archived ||
        !currentRoom.memberIds.includes(target.id) ||
        !currentRoom.memberIds.includes(chiefId)
      )
        throw new Error('协作成员已变化，请重新选择');
      const requestIdValue = id();
      const content = `协作请求 ${requestIdValue}：成员 ${context.botId} 请求 ${target.name} (${target.id}) 完成：${input.goal}\n交付要求：${input.expectedOutput}\n请使用 resolve_collaboration 接受或说明拒绝原因。`;
      const message = this.tasks.post(
        room.id,
        context.botId,
        context.runId,
        content,
        input.artifactIds,
      );
      let chief = s
        .byField<Task>('tasks', 'conversationId', room.id)
        .find((task) => task.botId === chiefId && !task.kind && !terminal(task.status));
      chief = chief
        ? this.tasks.appendInput(chief, message)
        : this.tasks.create({
            conversationId: room.id,
            botId: chiefId,
            goal: content,
            inputArtifactIds: input.artifactIds,
            requestId: `collaboration-chief:${requestIdValue}`,
            trigger: source.trigger,
          });
      return s.put<CollaborationRequest>('collaboration_requests', {
        ...input,
        id: requestIdValue,
        requestId,
        conversationId: room.id,
        sourceTaskId: source.id,
        sourceBotId: context.botId,
        chiefTaskId: chief.id,
        status: 'requested',
        createdAt: now(),
        updatedAt: now(),
      });
    });
    this.state.changed();
    return request;
  }
  async resolve(args: Record<string, unknown>, context: ToolExecutionContext) {
    const input = z
      .object({
        id: z.string(),
        action: z.enum(['accept', 'decline']),
        feedback: z.string().max(20000).default(''),
      })
      .parse(args);
    const s = this.state.storage;
    const request = required(
      s.get<CollaborationRequest>('collaboration_requests', input.id),
      '协作请求不存在',
    );
    if (
      context.botId !== this.state.settings().mainBotId ||
      context.conversation.id !== request.conversationId
    )
      throw new Error('此协作请求由所属团队主管处理');
    context.assertAuthorized?.();
    if (request.status !== 'requested') return request;
    if (!(await context.requestApproval('resolve_collaboration', '安排成员协作', input)))
      throw new Error('协作安排未获批准');
    context.assertAuthorized?.();
    context.markDispatched?.();
    const updated = s.transaction(() => {
      const current = required(
        s.get<CollaborationRequest>('collaboration_requests', request.id),
        '协作请求不存在',
      );
      if (current.status !== 'requested') return current;
      if (input.action === 'decline')
        return this.finish(current, 'declined', input.feedback || '主管未安排此次协作');
      const task = context.delegateTask(
        request.targetBotId,
        request.goal,
        request.expectedOutput,
        [],
        request.artifactIds,
      );
      return s.put<CollaborationRequest>('collaboration_requests', {
        ...request,
        status: 'assigned',
        targetTaskId: task.id,
        feedback: input.feedback,
        updatedAt: now(),
      });
    });
    this.state.changed();
    return updated;
  }
  private settle() {
    const s = this.state.storage;
    if (this.checking || this.version === s.tableVersion('tasks')) return;
    this.version = s.tableVersion('tasks');
    this.checking = true;
    try {
      for (const request of s.byField<CollaborationRequest>(
        'collaboration_requests',
        'status',
        'assigned',
      )) {
        const task = request.targetTaskId ? s.get<Task>('tasks', request.targetTaskId) : undefined;
        if (!task) continue;
        if (request.awaitingTaskResume) {
          if (task.status === 'interrupted') continue;
          request.awaitingTaskResume = undefined;
          s.put('collaboration_requests', request);
        }
        if (!terminal(task.status)) continue;
        const artifacts = task.artifactIds.filter((id) => {
          const artifact = s.get<Artifact>('artifacts', id);
          return artifact && artifact.purpose !== 'intermediate';
        });
        s.transaction(() =>
          this.finish(
            request,
            task.status === 'completed' ? 'completed' : 'failed',
            task.result || task.error || '协作任务已结束',
            artifacts,
          ),
        );
        this.state.changed();
      }
    } finally {
      this.checking = false;
    }
  }
  private finish(
    request: CollaborationRequest,
    status: 'declined' | 'completed' | 'failed',
    feedback: string,
    artifactIds: string[] = [],
  ) {
    const s = this.state.storage;
    const source = s.get<Task>('tasks', request.sourceTaskId);
    const room = s.get<Conversation>('conversations', request.conversationId);
    let replyTaskId: string | undefined;
    let deliveryError: string | undefined;
    const outcome = { completed: '已完成', declined: '未安排', failed: '未完成' }[status];
    if (
      source &&
      room &&
      !room.archived &&
      room.memberIds.includes(request.sourceBotId) &&
      s.get<Bot>('bots', request.sourceBotId) &&
      !s.get<Bot>('bots', request.sourceBotId)?.archived
    ) {
      const message = s.appendMessage({
        id: id(),
        conversationId: room.id,
        authorType: 'system',
        content: `协作 ${request.id} ${outcome}：\n${feedback}`,
        artifactIds,
        status: 'committed',
        createdAt: now(),
        targetBotIds: [request.sourceBotId],
      });
      try {
        const task = terminal(source.status)
          ? this.tasks.create({
              conversationId: room.id,
              botId: request.sourceBotId,
              goal: `收到协作结果，请结合原目标处理并回报。\n原目标：${source.goal}\n${message.content}`,
              inputArtifactIds: artifactIds,
              requestId: `collaboration-reply:${request.id}`,
              trigger: source.trigger,
            })
          : this.tasks.appendInput(source, message);
        replyTaskId = task.id;
      } catch (error) {
        deliveryError = error instanceof Error ? error.message : String(error);
      }
    }
    return s.put<CollaborationRequest>('collaboration_requests', {
      ...request,
      status,
      feedback,
      replyTaskId,
      deliveryError,
      updatedAt: now(),
    });
  }
}
