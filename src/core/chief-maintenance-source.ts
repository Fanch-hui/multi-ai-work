import { createHash } from 'node:crypto';
import type { ChiefContextView, ChiefInput } from '../domain/chief-work.js';
import { defaultContextWindow, managedContextBudget } from '../domain/context-settings.js';
import { terminal } from '../domain/task-status.js';
import type {
  Artifact,
  Bot,
  Connection,
  ContextOperation,
  Message,
  ProcessRecord,
  Run,
  Task,
  TaskInput,
} from '../domain/types.js';
import type { State } from './state.js';

export interface MaintenanceSource {
  fingerprint: string;
  partId: string;
  conversationId: string;
  run: Run;
  compactionId?: string;
  messages: Message[];
  tasks: Task[];
  artifacts: Artifact[];
  sourceMessageIds: string[];
  sourceArtifactIds: string[];
  pressured: boolean;
}

function contextTasks(state: State, view: ChiefContextView) {
  const tasks = new Map<string, Task>();
  const queue = view.conversationIds.flatMap((id) =>
    state.storage.byField<Task>('tasks', 'conversationId', id).filter((task) => !task.kind),
  );
  for (const task of queue) {
    if (tasks.has(task.id)) continue;
    tasks.set(task.id, task);
    queue.push(
      ...state.storage.byField<Task>('tasks', 'parentId', task.id).filter((child) => !child.kind),
    );
  }
  return [...tasks.values()];
}

function unresolvedInput(input: ChiefInput, view: ChiefContextView) {
  if (input.homeConversationId !== view.homeConversationId) return false;
  if (['dispatched', 'failed', 'cancelled'].includes(input.status)) return false;
  if (view.kind === 'main') return true;
  const target = input.contextId ?? input.targetContextId;
  if (target) return target === view.id;
  if (input.newContext) return false;
  return !input.focusContextId || input.focusContextId === view.id;
}

export function maintenanceReady(
  state: State,
  view: ChiefContextView,
  tasks = contextTasks(state, view),
) {
  const s = state.storage;
  if (tasks.some((task) => !terminal(task.status) || task.reconciliationRequired)) return false;
  if (s.all<ChiefInput>('chief_inputs').some((input) => unresolvedInput(input, view))) return false;
  const taskIds = new Set(tasks.map((task) => task.id));
  const pending = (table: 'questions' | 'approvals' | 'task_waits') =>
    s
      .all<{ taskId: string; status: string }>(table)
      .some((item) => taskIds.has(item.taskId) && item.status === 'pending');
  if (pending('questions') || pending('approvals') || pending('task_waits')) return false;
  if (
    s
      .all<TaskInput>('deliveries')
      .some(
        (input) =>
          input.kind === 'user-input' && taskIds.has(input.taskId) && input.status !== 'delivered',
      )
  )
    return false;
  if (
    s
      .all<ProcessRecord>('processes')
      .some(
        (process) => taskIds.has(process.taskId) && ['running', 'unknown'].includes(process.status),
      )
  )
    return false;
  return !s
    .all<{ runId: string; status: string }>('tool_operations')
    .some(
      (operation) =>
        tasks.some((task) => task.runIds.includes(operation.runId)) &&
        ['prepared', 'dispatched', 'unknown'].includes(operation.status),
    );
}

function contextPressure(
  state: State,
  view: ChiefContextView,
  tasks: Task[],
  seenCompactionId?: string,
) {
  const s = state.storage;
  const bot = s.get<Bot>('bots', state.settings().mainBotId!);
  const connection = bot && s.get<Connection>('connections', bot.connectionId);
  if (!bot?.model || connection?.status !== 'ready') return undefined;
  if (!['chatgpt', 'custom'].includes(connection.provider)) return undefined;
  const run = tasks
    .filter((task) => task.conversationId === view.conversationId)
    .flatMap((task) => [...task.runIds].reverse().map((id) => s.get<Run>('runs', id)))
    .filter((item): item is Run => !!item && !!item.endedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0);
  if (!run) return undefined;
  const window =
    bot.contextWindow ??
    defaultContextWindow(
      connection.provider,
      connection.models.find((model) => model.id === bot.model),
    );
  const budget = managedContextBudget(window, bot.compactionThreshold, bot.outputReserve);
  const threshold =
    typeof run.contextUsage?.triggerTokens === 'number'
      ? run.contextUsage.triggerTokens
      : budget.triggerTokens;
  const estimated = run.contextUsage?.estimatedTokens;
  const compaction = s
    .byField<ContextOperation>('compactions', 'bindingId', run.bindingId)
    .filter((item) => item.status === 'completed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0);
  const pressured =
    (typeof estimated === 'number' && !!threshold && estimated >= threshold) ||
    (!!compaction && compaction.id !== seenCompactionId);
  return { run, compactionId: compaction?.id, pressured, bot, connection };
}

export function maintenanceSource(
  state: State,
  view: ChiefContextView,
  seenCompactionId?: string,
): MaintenanceSource | undefined {
  const s = state.storage;
  const tasks = contextTasks(state, view);
  const pressure = contextPressure(state, view, tasks, seenCompactionId);
  if (!pressure) return undefined;
  const { run, bot, connection } = pressure;
  const messages = s
    .messages(view.conversationId)
    .filter((message) => message.status === 'committed');
  if (!messages.length) return undefined;
  const artifactIds = new Set(
    tasks.flatMap((task) => [...task.artifactIds, ...(task.inputArtifactIds ?? [])]),
  );
  const artifacts = [...artifactIds].flatMap((id) => {
    const artifact = s.get<Artifact>('artifacts', id);
    return artifact ? [artifact] : [];
  });
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        view.currentPartId,
        view.workspaceId,
        run.id,
        bot.revision,
        connection.revision,
        messages.map((message) => [message.id, message.content, message.artifactIds]),
        tasks.map((task) => [task.id, task.status, task.updatedAt, task.artifactIds]),
      ]),
    )
    .digest('hex');
  const recent = new Set([
    ...messages
      .filter((message) => message.authorType === 'user')
      .slice(-12)
      .map((message) => message.id),
    ...messages.slice(-12).map((message) => message.id),
  ]);
  return {
    fingerprint,
    partId: view.currentPartId,
    conversationId: view.conversationId,
    run,
    compactionId: pressure.compactionId,
    messages,
    tasks,
    artifacts,
    pressured: pressure.pressured,
    sourceMessageIds: messages
      .filter((message) => recent.has(message.id))
      .map((message) => message.id),
    sourceArtifactIds: artifacts.map((artifact) => artifact.id),
  };
}
