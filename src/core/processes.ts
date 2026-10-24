import type { CommandInput, ToolExecutionContext } from '../domain/tools.js';
import type { Bot, Conversation, ProcessRecord, Task } from '../domain/types.js';
import { commandDirectory } from '../tools/process.js';
import { workspacePath } from '../tools/paths.js';
import { commandTimeout, startCommand } from '../tools/process-runner.js';
import { id, now, type State } from './state.js';
import { waitOperation } from './wait-operation.js';
import { overlappingWorkspaces } from './workspace-authorization.js';

type LogChunk = { stream: 'stdout' | 'stderr'; text: string; offset: number };
type StoredProcess = ProcessRecord & { log?: LogChunk[]; logStart?: number; logEnd?: number };
type ActiveProcess = {
  record: StoredProcess;
  runner: ReturnType<typeof startCommand>;
  done: Promise<void>;
  listeners: Set<() => void>;
  dirty?: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
};
const LOG_LIMIT = 90_000;

function summary(record: StoredProcess) {
  const {
    stdout: _stdout,
    stderr: _stderr,
    log: _log,
    logStart: _start,
    logEnd: _end,
    ...value
  } = record;
  return { ...value, processId: record.id };
}

export class ProcessService {
  private active = new Map<string, ActiveProcess>();
  private closing = false;
  constructor(private readonly state: State) {}
  runService(input: CommandInput, context: ToolExecutionContext, environment: NodeJS.ProcessEnv) {
    return this.run(input, context, true, environment);
  }

  output(processId: string): { stdout: string; stderr: string; truncated: boolean } | undefined {
    const record =
      this.active.get(processId)?.record ??
      this.state.storage.get<StoredProcess>('processes', processId);
    return record
      ? { stdout: record.stdout ?? '', stderr: record.stderr ?? '', truncated: !!record.truncated }
      : undefined;
  }

  forContext(context: ToolExecutionContext) {
    return {
      run: (input: CommandInput, options?: { approved: boolean }) =>
        this.run(input, context, options?.approved),
      list: () =>
        this.state.storage
          .all<StoredProcess>('processes')
          .map((item) => this.active.get(item.id)?.record ?? item)
          .filter((item) => this.authorized(item, context, true))
          .map(summary),
      read: (input: { processId: string; offset?: number; limit?: number; waitMs?: number }) =>
        this.read(input, context),
      stop: (processId: string) => this.stop(processId, context),
    };
  }

  hasActive(workspaceId?: string) {
    return [...this.active.values()].some(
      (item) =>
        !workspaceId || overlappingWorkspaces(this.state, item.record.workspaceId, workspaceId),
    );
  }
  hasActiveRun(runId: string) {
    return [...this.active.values()].some((item) => item.record.runId === runId);
  }

  async waitForWorkspace(workspaceId: string, runId: string, signal: AbortSignal) {
    while (this.hasActive(workspaceId)) {
      signal.throwIfAborted();
      const running = [...this.active.values()].filter((item) =>
        overlappingWorkspaces(this.state, item.record.workspaceId, workspaceId),
      );
      if (running.some((item) => item.record.runId === runId))
        throw new Error('当前任务有活跃命令，请先完成或停止该命令');
      await waitOperation(Promise.race(running.map((item) => item.done)), signal);
    }
  }

  async settleRun(runId: string): Promise<boolean> {
    const running = [...this.active.values()].filter((item) => item.record.runId === runId);
    await this.stopAll(running);
    return running.length > 0;
  }

  async close() {
    this.closing = true;
    await this.stopAll([...this.active.values()]);
  }

  recover() {
    for (const record of this.state.storage
      .all<StoredProcess>('processes')
      .filter((item) => item.status === 'running')) {
      this.state.storage.put('processes', { ...record, status: 'unknown', endedAt: now() });
      const task = this.state.storage.get<Task>('tasks', record.taskId);
      if (task)
        this.state.storage.put('tasks', {
          ...task,
          status: 'interrupted',
          reconciliationRequired: true,
          error: '应用退出前命令尚未结束，需核查实际执行结果。',
          updatedAt: now(),
        });
    }
    this.state.changed();
  }

  private owns(record: StoredProcess, context: ToolExecutionContext) {
    return (
      record.taskId === context.task.id &&
      record.botId === context.botId &&
      record.conversationId === context.conversation.id &&
      record.workspaceId === context.workspace.id
    );
  }

  private isChief(context: ToolExecutionContext) {
    const chiefId = this.state.settings().mainBotId;
    if (!chiefId || context.botId !== chiefId || context.task.botId !== chiefId) return false;
    const bot = this.state.storage.get<Bot>('bots', context.botId);
    const room = this.state.storage.get<Conversation>('conversations', context.conversation.id);
    return (
      !!bot &&
      !bot.archived &&
      !!room &&
      !room.archived &&
      room.chiefId === chiefId &&
      room.memberIds.includes(chiefId) &&
      context.task.conversationId === room.id
    );
  }

  private authorized(record: StoredProcess, context: ToolExecutionContext, control = false) {
    return this.owns(record, context) || (control && !!this.isChief(context));
  }

  private get(processId: string, context: ToolExecutionContext, control = false) {
    const record =
      this.active.get(processId)?.record ??
      this.state.storage.get<StoredProcess>('processes', processId);
    if (!record || !this.authorized(record, context, control))
      throw new Error('命令不存在或未授权');
    return record;
  }

  private clearFlush(processId: string) {
    const active = this.active.get(processId);
    if (!active) return;
    if (active.flushTimer) {
      clearTimeout(active.flushTimer);
      active.flushTimer = undefined;
    }
    active.dirty = false;
  }

  private save(record: StoredProcess, contentOnly = false) {
    this.clearFlush(record.id);
    this.state.storage.put('processes', record);
    this.state.changed(contentOnly ? 'content' : 'state');
  }

  private async run(
    input: CommandInput,
    context: ToolExecutionContext,
    approved = false,
    environment?: NodeJS.ProcessEnv,
  ) {
    if (this.closing) throw new Error('命令服务正在关闭');
    commandTimeout(input);
    const cwd = environment
      ? await workspacePath(input.workdir ?? '.', context)
      : await commandDirectory(input, context, approved);
    context.signal.throwIfAborted();
    if (this.closing) throw new Error('命令服务正在关闭');
    if (this.hasActive(context.workspace.id))
      throw new Error('当前工作目录已有活跃命令，请先读取或停止该命令');
    const record: StoredProcess = {
      id: id(),
      runId: context.runId,
      taskId: context.task.id,
      botId: context.botId,
      conversationId: context.conversation.id,
      workspaceId: context.workspace.id,
      command: input.command,
      args: input.args,
      status: 'running',
      createdAt: now(),
      stdout: '',
      stderr: '',
      log: [],
      logStart: 0,
      logEnd: 0,
    };
    this.save(record);
    let runner: ReturnType<typeof startCommand>;
    try {
      context.markDispatched?.();
      runner = startCommand(
        input,
        cwd,
        (stream, text) => {
          if (!environment) this.append(record, stream, text);
        },
        context.signal,
        environment,
      );
    } catch (error) {
      record.status = 'failed';
      record.endedAt = now();
      this.save(record);
      throw error;
    }
    record.pid = runner.pid;
    const active: ActiveProcess = { record, runner, listeners: new Set(), done: Promise.resolve() };
    this.active.set(record.id, active);
    this.save(record);
    active.done = runner.done.then((outcome) => {
      this.clearFlush(record.id);
      record.status = outcome.status;
      record.code = outcome.code ?? undefined;
      record.signal = outcome.signal ?? undefined;
      record.endedAt = now();
      try {
        this.save(record);
      } finally {
        this.active.delete(record.id);
        for (const listener of active.listeners) listener();
      }
    });
    if (input.background) return summary(record);
    await active.done;
    context.signal.throwIfAborted();
    const result = await runner.done;
    if (result.error) throw result.error;
    return {
      ...summary(record),
      code: result.code,
      signal: result.signal,
      stdout: record.stdout,
      stderr: record.stderr,
      timedOut: record.status === 'timed_out',
    };
  }

  private append(record: StoredProcess, stream: 'stdout' | 'stderr', text: string) {
    record[stream] = ((record[stream] ?? '') + text).slice(stream === 'stdout' ? -60_000 : -30_000);
    record.log!.push({ stream, text, offset: record.logEnd! });
    record.logEnd! += text.length;
    while (record.logEnd! - record.logStart! > LOG_LIMIT) {
      const first = record.log![0],
        excess = record.logEnd! - record.logStart! - LOG_LIMIT;
      const removed = Math.min(excess, first.text.length);
      first.text = first.text.slice(removed);
      first.offset += removed;
      record.logStart! += removed;
      if (!first.text) record.log!.shift();
      record.truncated = true;
    }
    const active = this.active.get(record.id);
    if (!active) return;
    for (const listener of active.listeners) listener();
    active.dirty = true;
    active.flushTimer ??= setTimeout(() => {
      active.flushTimer = undefined;
      if (this.active.get(record.id) !== active || !active.dirty) return;
      active.dirty = false;
      try {
        this.save(record, true);
      } catch {
        active.dirty = true;
      }
    }, 100);
  }

  private async read(
    input: { processId: string; offset?: number; limit?: number; waitMs?: number },
    context: ToolExecutionContext,
  ) {
    let record = this.get(input.processId, context);
    const active = this.active.get(input.processId);
    if (active && (input.offset ?? 0) >= (record.logEnd ?? 0) && input.waitMs)
      await this.waitOutput(active, Math.min(input.waitMs, 10_000), context.signal);
    record = this.get(input.processId, context);
    const start = record.logStart ?? 0,
      end = record.logEnd ?? 0;
    const offset = Math.min(end, Math.max(input.offset ?? start, start));
    const nextOffset = Math.min(end, offset + Math.min(input.limit ?? 12_000, 60_000));
    const chunks = (record.log ?? []).flatMap((chunk) => {
      const from = Math.max(offset, chunk.offset),
        to = Math.min(nextOffset, chunk.offset + chunk.text.length);
      return from < to
        ? [
            {
              stream: chunk.stream,
              text: chunk.text.slice(from - chunk.offset, to - chunk.offset),
              offset: from,
            },
          ]
        : [];
    });
    return {
      ...summary(record),
      offset,
      nextOffset,
      totalLength: end,
      truncated: record.truncated || (input.offset ?? start) < start,
      stdout: chunks
        .filter((chunk) => chunk.stream === 'stdout')
        .map((chunk) => chunk.text)
        .join(''),
      stderr: chunks
        .filter((chunk) => chunk.stream === 'stderr')
        .map((chunk) => chunk.text)
        .join(''),
      chunks,
    };
  }

  private async waitOutput(active: ActiveProcess, waitMs: number, signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        active.listeners.delete(finish);
        signal.removeEventListener('abort', cancel);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const cancel = () => {
        cleanup();
        reject(signal.reason ?? new Error('读取已取消'));
      };
      const timer = setTimeout(finish, waitMs);
      active.listeners.add(finish);
      signal.addEventListener('abort', cancel, { once: true });
    });
    signal.throwIfAborted();
  }

  private async stop(processId: string, context: ToolExecutionContext) {
    context.signal.throwIfAborted();
    const record = this.get(processId, context, true);
    if (this.active.has(processId) && !this.owns(record, context)) {
      const owner = this.state.storage.get<Bot>('bots', record.botId);
      if (
        !(await context.requestApproval(
          'stop_process',
          `停止 ${owner?.name ?? record.botId} 的命令：${record.command}`,
          {
            processId,
            botId: record.botId,
            taskId: record.taskId,
            conversationId: record.conversationId,
          },
        ))
      )
        throw new Error('停止命令未获批准');
    }
    context.signal.throwIfAborted();
    this.get(processId, context, true);
    const active = this.active.get(processId);
    if (active) {
      context.markDispatched?.();
      active.record.stoppedByBotId = context.botId;
      active.record.stoppedByTaskId = context.task.id;
      this.save(active.record);
      await this.stopAll([active]);
    }
    return summary(this.get(processId, context, true));
  }

  private async stopAll(active: ActiveProcess[]) {
    for (const item of active) item.runner.stop();
    await Promise.all(active.map((item) => item.done));
  }
}
