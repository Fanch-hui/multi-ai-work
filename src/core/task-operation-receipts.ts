import type { Artifact, Bot, Conversation, ProcessRecord, Task } from '../domain/types.js';
import {
  artifactContentLookup,
  matchesArtifact,
  sourceContent,
} from './artifact-content-source.js';
import type { State } from './state.js';
import { accessibleArtifacts } from './tool-access.js';

interface Operation {
  id: string;
  runId: string;
  name: string;
  status: string;
  result?: unknown;
  modelResult?: unknown;
  requirementVersion?: number;
}
const receiptTools = new Set([
  'create_task_group',
  'delegate_task',
  'configure_bot',
  'write_artifact',
  'delete_file',
  'run_command',
  'call_mcp',
]);
const taskFields = [
  'id',
  'botId',
  'conversationId',
  'parentId',
  'status',
  'requestId',
  'planId',
  'planStepId',
  'dependencyIds',
  'artifactIds',
  'inputArtifactIds',
  'reconciliationRequired',
  'coordinationPaused',
  'result',
  'error',
];

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}

function taskResult(value: Record<string, unknown>) {
  const requirement = object(value.requirement);
  return {
    ...pick(value, taskFields),
    ...(requirement ? { requirement: pick(requirement, ['version']) } : {}),
  };
}

function knownResult(name: string, value: Record<string, unknown>): unknown | undefined {
  if (name === 'create_task_group') {
    const conversation = object(value.conversation),
      task = object(value.task);
    if (typeof conversation?.id !== 'string' || typeof task?.id !== 'string') return;
    return {
      conversation: pick(conversation, [
        'id',
        'name',
        'kind',
        'purpose',
        'workspaceId',
        'memberIds',
        'sourceTaskId',
        'sourceConversationId',
      ]),
      task: taskResult(task),
    };
  }
  if (name === 'delete_file' && typeof value.deleted === 'string')
    return { deleted: value.deleted };
  if (typeof value.id !== 'string') return;
  if (
    name === 'delegate_task' &&
    typeof value.status === 'string' &&
    typeof value.botId === 'string' &&
    typeof value.conversationId === 'string'
  )
    return taskResult(value);
  if (name === 'configure_bot' && typeof value.revision === 'number')
    return pick(value, [
      'id',
      'name',
      'role',
      'connectionId',
      'model',
      'reasoning',
      'contextWindow',
      'compactionThreshold',
      'revision',
      'archived',
    ]);
  if (
    name === 'write_artifact' &&
    typeof value.path === 'string' &&
    typeof value.sha256 === 'string'
  )
    return pick(value, [
      'id',
      'name',
      'path',
      'workingPath',
      'mimeType',
      'size',
      'sha256',
      'version',
      'requirementVersion',
      'superseded',
      'purpose',
      'taskId',
      'botId',
      'conversationId',
    ]);
}

function completeProcessOutput(state: State, task: Task, bot: Bot, value: Record<string, unknown>) {
  const current = state.storage.get<Bot>('bots', bot.id);
  if (
    !current ||
    current.archived ||
    !current.toolNames.includes('read_process') ||
    !bot.toolNames.includes('read_process') ||
    typeof value.processId !== 'string'
  )
    return;
  const process = state.storage.get<ProcessRecord & { logStart?: number; log?: unknown[] }>(
    'processes',
    value.processId,
  );
  const room = state.storage.get<Conversation>('conversations', task.conversationId);
  if (
    !process ||
    process.taskId !== task.id ||
    process.botId !== bot.id ||
    process.conversationId !== task.conversationId ||
    process.workspaceId !== room?.workspaceId ||
    process.status === 'running' ||
    process.status === 'unknown' ||
    process.truncated ||
    process.logStart !== 0 ||
    !Array.isArray(process.log)
  )
    return;
  if (process.stdout !== value.stdout || process.stderr !== value.stderr) return;
  return { tool: 'read_process', processId: process.id, offset: 0 };
}

function sourceReference(state: State, operation: Operation, artifacts: readonly Artifact[]) {
  const value = operation.result ?? operation.modelResult;
  const expected = typeof value === 'string' ? value : JSON.stringify(value);
  for (const artifact of artifacts) {
    if (
      artifact.contentSource?.kind !== 'tool-operation' ||
      artifact.contentSource.operationId !== operation.id
    )
      continue;
    const content = sourceContent(artifact.contentSource, artifactContentLookup(state.storage));
    if (
      content !== undefined &&
      content === expected &&
      matchesArtifact(Buffer.from(content), artifact)
    )
      return {
        artifactId: artifact.id,
        tool: 'read_artifact',
        offset: 0,
        totalLength: content.length,
      };
  }
}

function receiptResult(
  state: State,
  operation: Operation,
  task: Task,
  bot: Bot,
  artifacts: readonly Artifact[],
) {
  const raw = operation.result ?? operation.modelResult;
  const value = object(raw);
  if (!value) return operation.modelResult ?? raw;
  const known = knownResult(operation.name, value);
  if (known !== undefined) return known;
  if (operation.name === 'run_command') {
    const fullResult =
      sourceReference(state, operation, artifacts) ??
      completeProcessOutput(state, task, bot, value);
    if (!fullResult) return operation.modelResult ?? raw;
    return {
      ...pick(value, [
        'id',
        'processId',
        'command',
        'args',
        'workspaceId',
        'status',
        'code',
        'signal',
        'timedOut',
        'truncated',
        'createdAt',
        'endedAt',
      ]),
      fullResult,
    };
  }
  if (operation.name === 'call_mcp') {
    // Media and unknown remote schemas keep their original semantics unless the exact result is readable.
    const content = value.content;
    if (Array.isArray(content) && content.some((part) => object(part)?.type !== 'text'))
      return operation.modelResult ?? raw;
    const fullResult = sourceReference(state, operation, artifacts);
    if (fullResult) return { ...pick(value, ['isError']), fullResult };
  }
  return operation.modelResult ?? raw;
}

export function taskOperationReceipts(state: State, task: Task, bot: Bot, room: Conversation) {
  const runs = task.runIds
    .map((runId) => ({
      runId,
      operations: state.storage
        .byField<Operation>('tool_operations', 'runId', runId)
        .filter(
          (operation) => operation.status === 'succeeded' && receiptTools.has(operation.name),
        ),
    }))
    .filter((run) => run.operations.length);
  if (!runs.length) return [];
  const current = state.storage.get<Bot>('bots', bot.id);
  const allowed =
    current &&
    !current.archived &&
    current.toolNames.includes('read_artifact') &&
    bot.toolNames.includes('read_artifact');
  const needsSource = runs.some((run) =>
    run.operations.some(
      (operation) => operation.name === 'run_command' || operation.name === 'call_mcp',
    ),
  );
  const artifacts = allowed && needsSource ? accessibleArtifacts(state, room, bot.id, task) : [];
  const receipts: Record<string, unknown>[] = [];
  for (const { runId, operations } of runs) {
    const summaries = state.storage
      .prepare(`SELECT json_extract(payload, '$.data.callId') AS callId,
      json_extract(payload, '$.data.summary') AS summary FROM run_events WHERE run_id = ?
      AND json_extract(payload, '$.type') = 'tool' AND json_type(payload, '$.data.summary') = 'text'`)
      .all(runId) as { callId: string; summary: string }[];
    const byCall = new Map(summaries.map((item) => [item.callId, item.summary]));
    for (const operation of operations) {
      const callId = operation.id.startsWith(`${runId}:`)
        ? operation.id.slice(runId.length + 1)
        : undefined;
      receipts.push({
        operationId: operation.id,
        runId,
        ...(callId ? { callId } : {}),
        tool: operation.name,
        status: 'succeeded',
        ...(operation.requirementVersion !== undefined
          ? { requirementVersion: operation.requirementVersion }
          : {}),
        ...(callId && byCall.has(callId) ? { summary: byCall.get(callId) } : {}),
        result: receiptResult(state, operation, task, current ?? bot, artifacts),
      });
    }
  }
  return receipts;
}
