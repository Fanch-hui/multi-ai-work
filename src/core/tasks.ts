import type {
  Artifact,
  Bot,
  Connection,
  Conversation,
  Message,
  Run,
  Task,
} from '../domain/types.js';
import { State, id, now } from './state.js';
import { accessibleArtifacts } from './tool-access.js';
import { required } from './errors.js';
import { createHash } from 'node:crypto';
import { isChiefProvider } from '../domain/chief-provider.js';
import { validateBotSkills } from './market/bot-policy.js';
import { TaskPlanService } from './task-plans.js';
import { TaskInputService } from './task-inputs.js';
import { receivingTask } from './task-input-records.js';
import { latestProgressRun } from './managed-progress.js';
import { requireAttachmentCapacity } from '../domain/attachment-policy.js';

import { terminal } from '../domain/task-status.js';
export { terminal } from '../domain/task-status.js';
export class TaskService {
  private blockedConversations = new Set<string>();
  private maintenanceBlocked = false;
  constructor(private state: State) {}

  setMaintenanceBlocked(blocked: boolean) {
    this.maintenanceBlocked = blocked;
  }

  blockConversation(conversationId: string) {
    if (this.blockedConversations.has(conversationId)) throw new Error('对话正在修改，请稍后再试');
    this.blockedConversations.add(conversationId);
  }
  unblockConversation(conversationId: string) {
    this.blockedConversations.delete(conversationId);
  }
  accepting(conversationId: string) {
    const room = this.state.storage.get<Conversation>('conversations', conversationId);
    return (
      !this.maintenanceBlocked &&
      !!room &&
      !room.archived &&
      !this.blockedConversations.has(conversationId)
    );
  }
  private requireActive(conversationId: string) {
    if (!this.accepting(conversationId)) throw new Error('对话已归档或正在修改，请先恢复对话');
  }

  create(input: {
    conversationId: string;
    botId: string;
    goal: string;
    expectedOutput?: string;
    parentId?: string;
    dependencyIds?: string[];
    inputArtifactIds?: string[];
    requestId?: string;
    kind?: Task['kind'];
    questionId?: string;
    planStepId?: string;
    sourceMessageId?: string;
  }): Task {
    const s = this.state.storage;
    this.requireActive(input.conversationId);
    const requestId = input.requestId ?? id();
    const room = required(s.get<Conversation>('conversations', input.conversationId), '对话不存在');
    const bot = required(s.get<Bot>('bots', input.botId), '智能体不存在');
    if (bot.archived || !room.memberIds.includes(bot.id))
      throw new Error('智能体不是当前会话的有效成员');
    validateBotSkills(this.state, bot);
    const connection = required(
      s.get<Connection>('connections', bot.connectionId),
      '请先为智能体配置模型连接',
    );
    if (bot.id === this.state.settings().mainBotId && !isChiefProvider(connection.provider))
      throw new Error('管家请选择 ChatGPT 或自定义 API 连接');
    const existing = s.firstByField<Task>('tasks', 'requestId', requestId);
    if (existing) {
      if (
        existing.conversationId !== room.id ||
        existing.botId !== bot.id ||
        existing.goal !== input.goal
      )
        throw new Error('任务请求 ID 与任务内容不匹配');
      return existing;
    }
    const parent = input.parentId
      ? required(s.get<Task>('tasks', input.parentId), '父任务不存在')
      : undefined;
    const sourceRoom = parent
      ? s.get<Conversation>('conversations', parent.conversationId)
      : undefined;
    const taskGroupStart =
      parent &&
      room.purpose === 'task' &&
      room.sourceTaskId === parent.id &&
      room.sourceConversationId === parent.conversationId &&
      sourceRoom?.purpose === 'chief' &&
      sourceRoom.kind === 'private' &&
      parent.botId === this.state.settings().mainBotId &&
      bot.id === parent.botId &&
      room.chiefId === parent.botId;
    if (
      parent &&
      ((parent.conversationId !== room.id && !taskGroupStart) || terminal(parent.status))
    )
      throw new Error('父任务不允许继续委派');
    if (
      parent &&
      (parent.botId !== this.state.settings().mainBotId || parent.botId !== room.chiefId)
    )
      throw new Error('只有主管智能体可委派任务');
    if (parent && bot.id === parent.botId && !taskGroupStart) throw new Error('不能向自己委派任务');
    const depth = parent ? parent.depth + 1 : 0;
    if (
      parent &&
      s.countByField('tasks', 'parentId', parent.id) >= this.state.settings().maxChildren
    )
      throw new Error('达到子任务数量上限');
    const planned = input.planStepId
      ? new TaskPlanService(this.state).delegation(
          required(parent, '安排委派缺少主管任务'),
          room,
          bot.id,
          input.planStepId,
        )
      : undefined;
    const dependencies = [
      ...new Set([...(input.dependencyIds ?? []), ...(planned?.dependencyIds ?? [])]),
    ];
    for (const dependencyId of dependencies) {
      const dependency = required(s.get<Task>('tasks', dependencyId), '前置任务不存在');
      if (
        dependency.conversationId !== room.id ||
        dependency.id === parent?.id ||
        dependency.parentId !== parent?.id
      )
        throw new Error('前置依赖必须是当前任务树中的同级任务');
    }
    if (!input.goal.trim()) throw new Error('任务目标不能为空');
    const inputArtifactIds = [...new Set(input.inputArtifactIds ?? [])];
    const visible =
      parent && sourceRoom
        ? accessibleArtifacts(this.state, sourceRoom, parent.botId, parent)
        : accessibleArtifacts(this.state, room, bot.id);
    if (inputArtifactIds.some((artifactId) => !visible.some((item) => item.id === artifactId)))
      throw new Error('任务输入资料未授权');
    const task: Task = {
      id: id(),
      conversationId: room.id,
      botId: bot.id,
      parentId: parent?.id,
      dependencyIds: dependencies,
      goal: input.goal,
      expectedOutput: input.expectedOutput ?? '',
      status: 'queued',
      runIds: [],
      artifactIds: [],
      inputArtifactIds,
      requestId,
      depth,
      kind: input.kind,
      questionId: input.questionId,
      planId: planned?.planId,
      planStepId: planned?.planStepId,
      sourceMessageId: input.sourceMessageId,
      createdAt: now(),
      updatedAt: now(),
    };
    s.put('tasks', task);
    this.state.changed();
    return task;
  }

  send(input: {
    conversationId: string;
    content: string;
    targetBotIds?: string[];
    artifactIds?: string[];
    requestId?: string;
  }) {
    const s = this.state.storage;
    const room = required(s.get<Conversation>('conversations', input.conversationId), '对话不存在');
    this.requireActive(room.id);
    const artifactIds = [...new Set(input.artifactIds ?? [])];
    requireAttachmentCapacity(0, artifactIds.length);
    for (const artifactId of artifactIds) {
      const artifact = required(s.get<Artifact>('artifacts', artifactId), '资料不存在');
      if (artifact.conversationId !== room.id) throw new Error('资料不在当前会话中');
    }
    const content = input.content.trim() || (artifactIds.length ? '请阅读所附资料。' : '');
    if (!content) throw new Error('消息不能为空');
    const requestId = input.requestId ?? id();
    const mentionedBotIds = [...new Set(input.targetBotIds ?? [])];
    let targets = mentionedBotIds;
    if (!targets.length) {
      targets =
        room.kind === 'group'
          ? room.memberIds.filter((botId) => !s.get<Bot>('bots', botId)?.archived)
          : [room.chiefId ?? room.memberIds[0]];
    }
    if (!targets.length) throw new Error('会话没有有效成员');
    for (const botId of targets) {
      const bot = required(s.get<Bot>('bots', botId), '智能体不存在');
      if (bot.archived || !room.memberIds.includes(botId))
        throw new Error('智能体不是当前会话的有效成员');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          conversationId: room.id,
          content,
          targets: [...targets].sort(),
          mentionedBotIds: [...mentionedBotIds].sort(),
          artifactIds: [...artifactIds].sort(),
        }),
      )
      .digest('hex');
    const saved = s.metadata<{ messageId: string; taskIds: string[]; fingerprint?: string }>(
      `send:${requestId}`,
    );
    if (saved) {
      if (saved.fingerprint && saved.fingerprint !== fingerprint)
        throw new Error('消息请求 ID 与内容不匹配');
      return { messageId: saved.messageId, taskIds: saved.taskIds };
    }
    const result = s.transaction(() => {
      if (
        room.purpose === 'chief' &&
        !room.nameEdited &&
        !s.messages(room.id).length &&
        [s.get<Bot>('bots', room.chiefId!)?.name, '新对话'].includes(room.name)
      ) {
        s.put('conversations', { ...room, name: content.replace(/\s+/g, ' ').slice(0, 40) });
      }
      const message = s.appendMessage({
        id: id(),
        conversationId: room.id,
        authorType: 'user',
        content,
        artifactIds,
        status: 'committed',
        createdAt: now(),
        targetBotIds: targets,
        ...(mentionedBotIds.length ? { mentionedBotIds } : {}),
      });
      const tasks = targets.map((botId) => {
        const current = receivingTask(s, room.id, botId);
        if (!current)
          return this.create({
            conversationId: room.id,
            botId,
            goal: content,
            inputArtifactIds: artifactIds,
            requestId: `${requestId}:${botId}`,
            sourceMessageId: message.id,
          });
        return this.appendInput(current, message);
      });
      const value = { messageId: message.id, taskIds: tasks.map((task) => task.id) };
      s.setMetadata(`send:${requestId}`, { ...value, fingerprint });
      return value;
    });
    this.state.changed();
    return result;
  }

  appendInput(task: Task, message: Message): Task {
    new TaskInputService(this.state).append(task, message);
    const resume = task.status === 'waiting_children' || task.coordinationPaused;
    if (task.coordinationPaused) this.state.storage.setMetadata(`coordination:${task.id}`, 0);
    const patch: Partial<Task> = {
      inputArtifactIds: [...new Set([...(task.inputArtifactIds ?? []), ...message.artifactIds])],
    };
    if (resume) {
      patch.status = 'queued';
      patch.coordinationPaused = false;
      if (message.authorType === 'user') patch.error = undefined;
    }
    return this.update(task, patch);
  }

  update(task: Task, patch: Partial<Task>) {
    const current = required(this.state.storage.get<Task>('tasks', task.id), '任务不存在');
    const updated = { ...current, ...patch, updatedAt: now() };
    this.state.storage.put('tasks', updated);
    this.state.changed();
    return updated;
  }

  retry(taskId: string): Task {
    const old = required(this.state.storage.get<Task>('tasks', taskId), '任务不存在');
    this.requireActive(old.conversationId);
    const room = required(
      this.state.storage.get<Conversation>('conversations', old.conversationId),
      '对话不存在',
    );
    const bot = required(this.state.storage.get<Bot>('bots', old.botId), '智能体不存在');
    if (bot.archived || !room.memberIds.includes(bot.id))
      throw new Error('智能体不是当前会话的有效成员');
    if (old.status === 'waiting_input' && old.coordinationPaused) {
      const children = this.state.storage.byField<Task>('tasks', 'parentId', old.id);
      if (children.some((child) => !terminal(child.status) || child.reconciliationRequired))
        throw new Error('请先核查并等待成员任务停止');
      this.state.storage.setMetadata(
        `results:${old.id}`,
        children.map((child) => ({
          taskId: child.id,
          botId: child.botId,
          status: child.status,
          result: child.result,
          error: child.error,
          artifactIds: child.artifactIds,
          updatedAt: child.updatedAt,
        })),
      );
      this.state.storage.setMetadata(`coordination:${old.id}`, 0);
      return this.update(old, {
        status: 'queued',
        error: undefined,
        coordinationPaused: false,
        artifactIds: [
          ...new Set([...old.artifactIds, ...children.flatMap((child) => child.artifactIds)]),
        ],
      });
    }
    if (!['failed', 'cancelled', 'interrupted'].includes(old.status))
      throw new Error('只有已停止的任务可以重试');
    if (old.reconciliationRequired) throw new Error('执行结果尚未确认，请先核查外部操作');
    const children = this.state.storage.byField<Task>('tasks', 'parentId', old.id);
    if (children.some((child) => child.reconciliationRequired))
      throw new Error('请先核查成员任务的外部操作');
    if (children.some((child) => !terminal(child.status))) throw new Error('请等待成员任务停止');
    if (children.length)
      this.state.storage.setMetadata(
        `results:${old.id}`,
        children.map((child) => ({
          taskId: child.id,
          botId: child.botId,
          status: child.status,
          result: child.result,
          error: child.error,
          artifactIds: child.artifactIds,
          updatedAt: child.updatedAt,
        })),
      );
    this.state.storage.setMetadata(`coordination:${old.id}`, 0);
    return this.update(old, {
      status: 'queued',
      error: undefined,
      result: undefined,
      coordinationPaused: false,
      recovery: undefined,
      resumeFromRunId: latestProgressRun(this.state.storage, old),
    });
  }

  settleParents() {
    const s = this.state.storage;
    for (const parent of s.byField<Task>('tasks', 'status', 'waiting_children')) {
      if (!this.accepting(parent.conversationId)) continue;
      const children = s.byField<Task>('tasks', 'parentId', parent.id);
      if (!children.length || children.some((child) => !terminal(child.status))) continue;
      if (children.some((child) => child.reconciliationRequired)) {
        this.update(parent, {
          status: 'interrupted',
          reconciliationRequired: true,
          error: '成员任务有未知操作，请先核查。',
        });
        continue;
      }
      const round = s.metadata<number>(`coordination:${parent.id}`) ?? 0;
      const limit = this.state.settings().maxCoordinationRounds;
      if (limit > 0 && round >= limit) {
        this.update(parent, {
          status: 'waiting_input',
          coordinationPaused: true,
          error: '达到主管自动跟进次数上限，可查看成果后继续处理。',
        });
        continue;
      }
      const notificationId = `${parent.id}:${children.map((child) => `${child.id}:${child.updatedAt}`).join('|')}`;
      if (s.get('notifications', notificationId)) continue;
      s.transaction(() => {
        s.put('notifications', {
          id: notificationId,
          parentId: parent.id,
          childIds: children.map((child) => child.id),
        });
        s.setMetadata(`coordination:${parent.id}`, round + 1);
        s.setMetadata(
          `results:${parent.id}`,
          children.map((child) => ({
            taskId: child.id,
            botId: child.botId,
            status: child.status,
            result: child.result,
            error: child.error,
            artifactIds: child.artifactIds,
            updatedAt: child.updatedAt,
          })),
        );
        this.update(parent, {
          status: 'queued',
          artifactIds: [
            ...new Set([...parent.artifactIds, ...children.flatMap((child) => child.artifactIds)]),
          ],
        });
      });
    }
  }

  post(
    conversationId: string,
    botId: string,
    runId: string,
    content: string,
    artifactIds: string[] = [],
    targetConversationId = conversationId,
  ): Message {
    const s = this.state.storage;
    const room = required(s.get<Conversation>('conversations', conversationId), '会话不存在');
    const run = s.get<Run>('runs', runId);
    const task = run && s.get<Task>('tasks', run.taskId);
    const target = this.messageRoom(room, botId, task, targetConversationId);
    this.requireActive(target.id);
    const visible = new Set(
      accessibleArtifacts(this.state, room, botId, task).map((item) => item.id),
    );
    for (const artifactId of artifactIds) {
      required(s.get<Artifact>('artifacts', artifactId), '工件不存在');
      if (!visible.has(artifactId)) throw new Error('工件不在当前会话中');
    }
    const message = s.transaction(() => {
      const draft = s
        .messages(target.id)
        .find(
          (message) =>
            message.runId === runId && message.authorBotId === botId && message.status === 'draft',
        );
      if (draft) {
        if (draft.content.trim() || draft.artifactIds.length)
          s.updateMessage({ ...draft, status: 'committed' });
        else s.deleteMessage(draft.id);
      }
      // Publication follows the current cursor so readers cannot skip a previously empty draft.
      return s.appendMessage({
        id: id(),
        conversationId: target.id,
        authorType: 'bot',
        authorBotId: botId,
        runId,
        content,
        artifactIds,
        status: 'committed',
        createdAt: now(),
      });
    });
    this.state.changed();
    return message;
  }

  private messageRoom(
    room: Conversation,
    botId: string,
    task: Task | undefined,
    targetId: string,
  ): Conversation {
    if (targetId === room.id) return room;
    const s = this.state.storage;
    const target = required(s.get<Conversation>('conversations', targetId), '会话不存在或未授权');
    const source = target.sourceTaskId ? s.get<Task>('tasks', target.sourceTaskId) : undefined;
    if (
      botId !== this.state.settings().mainBotId ||
      room.kind !== 'private' ||
      room.purpose !== 'chief' ||
      room.chiefId !== botId ||
      task?.conversationId !== room.id ||
      task.botId !== botId ||
      target.kind !== 'group' ||
      target.purpose !== 'task' ||
      target.chiefId !== botId ||
      !target.memberIds.includes(botId) ||
      target.sourceConversationId !== room.id ||
      source?.conversationId !== room.id ||
      source.botId !== botId
    )
      throw new Error('只能向当前主对话的关联任务群发言');
    return target;
  }
}
