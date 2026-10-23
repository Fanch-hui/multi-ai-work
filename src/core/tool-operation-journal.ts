import { createHash } from 'node:crypto';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Artifact, Run } from '../domain/types.js';
import { publicError } from './errors.js';
import { id, now, type State } from './state.js';
import { toolSummary } from './tool-summary.js';
import type { ToolTiming } from './tool-timing.js';

export interface ToolCall {
  name: string;
  requestedName: string;
  botId: string;
  args: Record<string, unknown>;
  callId: string;
  context: ToolExecutionContext;
  timing: ToolTiming;
}

interface Operation {
  id: string;
  fingerprint: string;
  runId: string;
  name: string;
  status: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'unknown';
  result?: unknown;
  modelResult?: unknown;
  error?: string;
  errorCode?: string;
  requirementVersion?: number;
}

type OperationLookup =
  | { kind: 'reused'; result: unknown }
  | { kind: 'prepared'; operation?: Operation; operationId: string; fingerprint: string };

/** Keeps operation reconciliation and the persisted lifecycle in one place. */
export class ToolOperationJournal {
  private summary?: string;

  constructor(
    private state: State,
    private call: ToolCall,
  ) {}

  lookup(): OperationLookup {
    const { name, args, callId, context, timing } = this.call;
    const resumedId = context.resumeOperations?.[callId];
    const operationId = resumedId ?? `${context.runId}:${callId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
    const existing = this.state.storage.get<Operation>('tool_operations', operationId);
    if (resumedId) {
      const source = existing && this.state.storage.get<Run>('runs', existing.runId);
      if (!source || source.taskId !== context.task.id || source.botId !== this.call.botId)
        throw new Error('恢复的工具操作不属于当前任务');
    }
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('工具调用 ID 与参数不匹配');
      if (existing.status === 'succeeded') {
        timing.status = 'reused';
        return { kind: 'reused', result: existing.modelResult ?? existing.result };
      }
      if (resumedId && existing.status === 'failed')
        return { kind: 'reused', result: { error: existing.error ?? '工具执行失败' } };
      if (!resumedId || existing.status !== 'prepared')
        throw new Error('工具调用已有执行记录，请先核查实际结果');
    }
    return { kind: 'prepared', operation: existing, operationId, fingerprint };
  }

  start(lookup: Extract<OperationLookup, { kind: 'prepared' }>) {
    const { context, name, args } = this.call;
    const operation: Operation = lookup.operation ?? {
      id: lookup.operationId,
      fingerprint: lookup.fingerprint,
      runId: context.runId,
      name,
      status: 'prepared',
      requirementVersion: this.state.storage.get<Run>('runs', context.runId)?.requirementVersion,
    };
    this.summary = toolSummary(name, args);
    this.save(operation);
    this.event(this.call.requestedName, 'running');
    this.state.changed();
    return operation;
  }

  dispatched(operation: Operation) {
    this.save({ ...operation, status: 'dispatched' });
  }

  complete(operation: Operation, result: unknown) {
    this.save({ ...operation, status: 'succeeded', result });
    const command: Record<string, unknown> = {};
    if (
      this.call.name === 'run_command' &&
      result &&
      typeof result === 'object' &&
      'status' in result
    ) {
      command.commandStatus = result.status;
      command.exitCode = 'code' in result ? result.code : undefined;
    }
    this.event(this.call.name, 'completed', command);
  }

  finish(operation: Operation, result: unknown, modelResult: unknown) {
    this.save({ ...operation, status: 'succeeded', result, modelResult });
    this.call.timing.status = 'succeeded';
    this.state.changed();
  }

  fail(operation: Operation, error: unknown, dispatched: boolean) {
    const { name, args, context } = this.call;
    const unknown =
      dispatched &&
      (context.signal.aborted ||
        (['call_mcp', 'browser_action', 'browser_open', 'browser_tabs'].includes(name) &&
          /unknown|结果未知|ECONNRESET|ETIMEDOUT|closed|timeout|timed out|断开/i.test(
            publicError(error),
          )));
    let errorCode: string | undefined;
    if (name === 'read_artifact' && typeof args.artifactId === 'string') {
      errorCode = this.state.storage.get<Artifact>('artifacts', args.artifactId)
        ? 'artifact_unauthorized'
        : 'artifact_missing';
    }
    this.save({
      ...operation,
      status: unknown ? 'unknown' : 'failed',
      error: publicError(error),
      errorCode,
    });
    this.event(name, 'failed', { error: publicError(error) });
    this.state.changed();
    if (context.signal.aborted) throw error;
    return { error: publicError(error) };
  }

  private save(operation: Operation) {
    this.call.timing.measure('saveMs', () => this.state.storage.put('tool_operations', operation));
  }

  private event(name: string, status: string, details: Record<string, unknown> = {}) {
    this.state.storage.event({
      id: id(),
      runId: this.call.context.runId,
      type: 'tool',
      data: {
        name,
        callId: this.call.callId,
        summary: this.summary,
        status,
        source: 'app',
        ...details,
      },
      createdAt: now(),
    });
  }
}
