import { createHash } from 'node:crypto';
import type { ChiefWorkInput, ChiefWorkContext } from '../domain/chief-work.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Conversation, Task, Workspace } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import type { State } from './state.js';
import { id, now } from './state.js';
import type { TaskService } from './tasks.js';
import type { ChiefContextService } from './chief-contexts.js';
import { required } from './errors.js';
import { ChiefWorkReports } from './chief-work-reports.js';
import { accessibleArtifacts } from './tool-access.js';

export class ChiefWorkService {
  private reports: ChiefWorkReports;
  constructor(
    private state: State,
    private tasks: TaskService,
    private contexts: ChiefContextService,
  ) {
    this.reports = new ChiefWorkReports(state, tasks, contexts);
  }
  startReports() {
    this.reports.start();
  }
  closeReports() {
    this.reports.close();
  }
  private authorize(context: ToolExecutionContext) {
    const main = this.contexts.main();
    if (
      context.botId !== this.state.settings().mainBotId ||
      context.conversation.id !== main.room.id ||
      context.task.kind
    )
      throw new Error('独立工作由管家主对话安排');
    context.assertAuthorized?.();
    context.signal.throwIfAborted();
    return main;
  }
  list(context: ToolExecutionContext) {
    this.authorize(context);
    return chiefWorkBriefs(this.state);
  }
  start(input: ChiefWorkInput, context: ToolExecutionContext) {
    this.authorize(context);
    const s = this.state.storage;
    const requestId = `chief-work:${context.task.id}:${required(context.callId, '工作调用缺少幂等标识')}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const saved = s.metadata<{
      fingerprint: string;
      workId: string;
      taskId: string;
      conversationId: string;
    }>(requestId);
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw new Error('工作调用与已保存要求不匹配');
      return { workId: saved.workId, taskId: saved.taskId, conversationId: saved.conversationId };
    }
    const sourceMessageIds = this.sourceMessages(input.sourceMessageIds, context);
    const artifactIds = [...new Set(input.artifactIds ?? [])];
    if (artifactIds.some((artifactId) => !context.findArtifact(artifactId)))
      throw new Error('工作资料未授权');
    const prior = input.workId ? this.contexts.current(input.workId) : undefined;
    if (prior && prior.context.kind === 'main') throw new Error('请选择具体工作继续');
    const workspace = this.workspace(input, prior?.room);
    const previousTask = prior
      ? (this.contexts
          .list()
          .find((item) => item.id === prior.context.id)!
          .conversationIds.flatMap((roomId) => s.byField<Task>('tasks', 'conversationId', roomId))
          .filter((task) => !task.kind && task.botId === context.botId)
          .at(-1) ??
        (prior.context.legacyTaskId ? s.get<Task>('tasks', prior.context.legacyTaskId) : undefined))
      : undefined;
    if (previousTask?.reconciliationRequired) throw new Error('请先核查这项工作尚未确认的操作');
    if (
      previousTask &&
      prior &&
      !terminal(previousTask.status) &&
      previousTask.conversationId !== prior.room.id
    )
      throw new Error('原工作仍在执行，请使用 list_work 找到当前工作并补充要求');
    const priorReferences = new Set([
      ...(previousTask?.artifactIds ?? []),
      ...(previousTask?.inputArtifactIds ?? []),
      ...(previousTask
        ? (s.metadata<string[]>(`returned-artifacts:${previousTask.id}`) ?? [])
        : []),
      ...(prior?.part.sourceArtifactIds ?? []),
    ]);
    const priorRoom = previousTask
      ? s.get<Conversation>('conversations', previousTask.conversationId)
      : prior?.room;
    const priorArtifactIds = priorRoom
      ? accessibleArtifacts(this.state, priorRoom, context.botId, previousTask)
          .filter((artifact) => priorReferences.has(artifact.id))
          .map((artifact) => artifact.id)
      : [];
    if (prior) {
      const partIds = new Set(prior.part.sourceArtifactIds);
      priorArtifactIds.push(
        ...accessibleArtifacts(this.state, prior.room, context.botId)
          .filter((artifact) => partIds.has(artifact.id))
          .map((artifact) => artifact.id),
      );
    }
    const taskArtifactIds = [...new Set([...artifactIds, ...priorArtifactIds])];

    const result = s.transaction(() => {
      const work =
        prior?.context ??
        this.contexts.create({
          title: input.title ?? input.goal.slice(0, 120),
          workspaceId: workspace.id,
          kind: 'work',
          sourceTaskId: context.task.id,
          sourceMessageIds,
        });
      let current = this.contexts.current(work.id);
      if (prior?.context.kind === 'history') {
        this.contexts.rotate(
          work.id,
          `继续此前工作：${previousTask?.goal ?? work.title}\n此前结果：${previousTask?.result ?? previousTask?.status ?? ''}`,
          [
            ...new Set([
              ...s
                .messages(current.room.id)
                .slice(-8)
                .map((message) => message.id),
              ...(prior?.part.sourceMessageIds ?? []),
              ...sourceMessageIds,
            ]),
          ],
          taskArtifactIds,
        );
        s.put('chief_contexts', {
          ...current.context,
          kind: 'work',
          currentPartId: this.contexts.current(work.id).part.id,
        });
        current = this.contexts.current(work.id);
      }
      const grants = `chief-artifact-grants:${current.room.id}`;
      s.setMetadata(grants, [
        ...new Set([...(s.metadata<string[]>(grants) ?? []), ...taskArtifactIds]),
      ]);
      const active = previousTask && !terminal(previousTask.status) ? previousTask : undefined;
      const message = s.appendMessage({
        id: id(),
        conversationId: current.room.id,
        authorType: 'user',
        content: input.expectedOutput
          ? `${input.goal}\n交付要求：${input.expectedOutput}`
          : input.goal,
        artifactIds,
        status: 'committed',
        createdAt: now(),
      });
      s.setMetadata(`chief-work-source:${message.id}`, {
        sourceTaskId: context.task.id,
        sourceMessageIds,
      });
      const task = active
        ? this.tasks.appendInput(active, message)
        : this.tasks.create({
            conversationId: current.room.id,
            botId: context.botId,
            goal: input.goal,
            expectedOutput: input.expectedOutput,
            inputArtifactIds: taskArtifactIds,
            sourceMessageId: message.id,
            requestId,
            reworkOfTaskId: previousTask?.id,
          });
      s.setMetadata(`chief-work-managed-task:${task.id}`, true);
      const value = { workId: work.id, taskId: task.id, conversationId: current.room.id };
      s.setMetadata(requestId, { fingerprint, ...value });
      return value;
    });
    this.state.changed();
    return result;
  }
  private workspace(input: ChiefWorkInput, prior?: Conversation) {
    const s = this.state.storage;
    if (prior) {
      if (input.workspaceId && input.workspaceId !== prior.workspaceId)
        throw new Error('续做沿用原项目，请另开工作处理其他项目');
      const workspace = required(s.get<Workspace>('workspaces', prior.workspaceId), '原项目不存在');
      if (workspace.enabled === false) throw new Error('原项目授权已撤销，请先恢复授权');
      if (input.project && workspace.name !== input.project.trim())
        throw new Error('续做项目与指定名称不一致，请先确认项目');
      return workspace;
    }
    const enabled = s.all<Workspace>('workspaces').filter((item) => item.enabled !== false);
    if (input.workspaceId) {
      const workspace = required(
        enabled.find((item) => item.id === input.workspaceId),
        '项目不存在或授权已撤销',
      );
      if (input.project && workspace.name !== input.project.trim())
        throw new Error('项目 ID 与名称不一致，请先确认项目');
      return workspace;
    }
    if (input.project) {
      const matches = enabled.filter((item) => item.name === input.project!.trim());
      if (matches.length !== 1)
        throw new Error(
          matches.length
            ? '存在同名项目，请询问用户确认目标目录'
            : '找不到指定项目，请询问用户确认名称或授权目录',
        );
      return matches[0];
    }
    return required(
      enabled.find((item) => item.id === this.state.settings().defaultWorkspaceId),
      '默认工作成果目录尚未就绪',
    );
  }
  private sourceMessages(sourceIds: string[] | undefined, context: ToolExecutionContext) {
    const s = this.state.storage;
    const selected = [
      ...new Set(sourceIds ?? (context.task.sourceMessageId ? [context.task.sourceMessageId] : [])),
    ];
    for (const sourceId of selected) {
      const message = required(s.getMessage(sourceId), '来源消息不存在');
      const room = s.get<Conversation>('conversations', message.conversationId);
      const granted = (
        s.metadata<string[]>(`chief-message-grants:${context.conversation.id}`) ?? []
      ).includes(sourceId);
      if (!granted && (room?.chiefHomeId !== this.contexts.homeId || room.chiefRole !== 'main'))
        throw new Error('请选择管家主对话的来源消息');
    }
    return selected;
  }
}

export function chiefWorkBriefs(state: State) {
  const s = state.storage;
  return s
    .byField<ChiefWorkContext>(
      'chief_contexts',
      'homeConversationId',
      state.settings().mainConversationId!,
    )
    .filter((work) => work.kind === 'work')
    .map((work) => {
      const rooms = s.byField<{ conversationId: string }>('chief_parts', 'contextId', work.id);
      const tasks = rooms
        .flatMap((part) => s.byField<Task>('tasks', 'conversationId', part.conversationId))
        .filter((task) => !task.kind && task.botId === state.settings().mainBotId);
      const latest = tasks.at(-1);
      const room = latest && s.get<Conversation>('conversations', latest.conversationId);
      return {
        workId: work.id,
        title: work.title,
        workspaceId: room?.workspaceId,
        project: room && s.get<Workspace>('workspaces', room.workspaceId)?.name,
        taskId: latest?.id,
        status: latest?.status,
        goal: latest?.goal,
        result: latest?.result?.slice(0, 1600),
        error: latest?.error,
        artifactIds: latest?.artifactIds ?? [],
        activeTaskIds: tasks.filter((task) => !terminal(task.status)).map((task) => task.id),
      };
    });
}
