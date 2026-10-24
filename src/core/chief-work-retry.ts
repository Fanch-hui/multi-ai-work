import type { ChiefContextPart, ChiefWorkContext } from '../domain/chief-work.js';
import type { Bot, Conversation, Task } from '../domain/types.js';
import type { State } from './state.js';
import { randomUUID } from 'node:crypto';
import type { TaskService } from './tasks.js';
import { ChiefContextService } from './chief-contexts.js';
import { accessibleArtifacts } from './tool-access.js';
import { taskOperationReceipts } from './task-operation-receipts.js';

export function retryChiefHistory(state: State, tasks: TaskService, old: Task, room: Conversation) {
  if (
    old.kind ||
    old.botId !== state.settings().mainBotId ||
    room.purpose !== 'chief' ||
    room.kind !== 'private'
  )
    return undefined;
  const s = state.storage;
  const part = s.firstByField<ChiefContextPart>('chief_parts', 'conversationId', room.id);
  const work = part && s.get<ChiefWorkContext>('chief_contexts', part.contextId);
  const previousPart = !!work && work.currentPartId !== part?.id;
  if (
    !previousPart &&
    work?.kind !== 'history' &&
    !['home', 'history'].includes(room.chiefRole ?? '')
  )
    return undefined;
  const requestId = `chief-history-retry:${old.id}`;
  const prior = s.firstByField<Task>('tasks', 'requestId', requestId);
  if (prior) return prior;
  const contexts = new ChiefContextService(state);
  return s.transaction(() => {
    const context =
      work ??
      contexts.create({
        title: old.goal.slice(0, 120),
        kind: 'work',
        workspaceId: room.workspaceId,
        legacyConversationId: room.id,
        legacyTaskId: old.id,
      });
    const messages = s
      .messages(room.id)
      .filter(
        (message) =>
          message.id === old.sourceMessageId ||
          (message.runId && old.runIds.includes(message.runId)),
      );
    const relevant = new Set([
      ...old.artifactIds,
      ...(old.inputArtifactIds ?? []),
      ...(s.metadata<string[]>(`returned-artifacts:${old.id}`) ?? []),
      ...messages.flatMap((message) => message.artifactIds),
    ]);
    const artifactIds = accessibleArtifacts(state, room, old.botId, old)
      .filter((artifact) => relevant.has(artifact.id))
      .map((artifact) => artifact.id);
    const bot = s.get<Bot>('bots', old.botId)!;
    const receipts = taskOperationReceipts(state, old, bot, room);
    const handoff = [
      `继续此前工作：${old.goal}`,
      `交付要求：${old.expectedOutput}`,
      old.result ? `此前结果：${old.result}` : '',
      old.error ? `此前停止原因：${old.error}` : '',
      receipts.length ? `已确认操作：${JSON.stringify(receipts)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const next =
      work && !previousPart
        ? contexts.rotate(
            context.id,
            handoff,
            messages.slice(-12).map((message) => message.id),
            artifactIds,
          )
        : context;
    if (context.kind !== 'main')
      s.put('chief_contexts', {
        ...s.get<ChiefWorkContext>('chief_contexts', context.id)!,
        kind: 'work',
      });
    const current = contexts.current(next.id);
    const grants = `chief-artifact-grants:${current.room.id}`;
    s.setMetadata(grants, [...new Set([...(s.metadata<string[]>(grants) ?? []), ...artifactIds])]);
    s.setMetadata(`chief-retry-source:${old.id}`, {
      taskId: old.id,
      sourceMessageIds: messages.map((message) => message.id),
      operationReceipts: receipts,
    });
    const source = s.appendMessage({
      id: randomUUID(),
      conversationId: current.room.id,
      authorType: 'system',
      content: `${handoff}\n来源消息：${messages.map((message) => message.id).join('、')}`,
      artifactIds,
      status: 'committed',
      createdAt: new Date().toISOString(),
    });
    const created = tasks.create({
      conversationId: current.room.id,
      botId: old.botId,
      goal: old.goal,
      expectedOutput: old.expectedOutput,
      inputArtifactIds: artifactIds,
      requestId,
      sourceMessageId: source.id,
      reworkOfTaskId: old.id,
    });
    if (context.kind !== 'main') s.setMetadata(`chief-work-managed-task:${created.id}`, true);
    return created;
  });
}
