import { randomBytes } from 'node:crypto';
import type {
  Bot,
  Connection,
  Conversation,
  Run,
  Task,
  Workspace,
  Usage,
} from '../domain/types.js';
import type { ProviderAdapter } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { ContextManager } from '../runtime/context.js';
import type { MemoryService } from '../runtime/memory.js';
import type { Vault } from '../security/vault.js';
import { State, id, now } from './state.js';
import { TaskService } from './tasks.js';
import { ToolRuntime } from './tool-runtime.js';
import { publicError, required } from './errors.js';
import { sessionBinding } from './session-binding.js';
import { emptyRunMetrics } from './run-metrics.js';
import { TaskInputService } from './task-inputs.js';
import { receivedRequirementVersion } from './task-requirements.js';
import {
  loadManagedProgress,
  restoreProgressInputs,
  restoreProgressTools,
} from './managed-progress.js';
import { RunReplyWriter } from './run-reply.js';
import { RunPreparation } from './run-preparation.js';
import { RunResults, type RunResultScope } from './run-results.js';

export class Executor {
  readonly nativeContexts = new Map<
    string,
    { context: ToolExecutionContext; bot: Bot; runId: string }
  >();
  coreUrl = '';
  private inputs: TaskInputService;
  private preparation: RunPreparation;
  private results: RunResults;

  constructor(
    private state: State,
    private tasks: TaskService,
    private tools: ToolRuntime,
    memory: MemoryService,
    contextManager: ContextManager,
    private vault: Vault,
    private adapters: ProviderAdapter[],
  ) {
    this.inputs = new TaskInputService(state);
    this.preparation = new RunPreparation(state, tools, memory, contextManager, vault, this.inputs);
    this.results = new RunResults(state, tasks, tools, this.inputs);
  }

  cancelQuestions(task: Task) {
    this.tools.questions.cancelTask(task.id);
    this.tools.waits.cancelTask(task.id);
    if (task.kind === 'question-decision') this.questionDecisionFailed(task, '主管代答已停止');
  }

  questionDecisionFailed(task: Task, error: string) {
    this.tools.questions.failDecision(task, error);
  }

  async execute(task: Task, callerSignal: AbortSignal) {
    const persistence = new AbortController();
    const signal = AbortSignal.any([callerSignal, persistence.signal]);
    const execution = this.startRun(task, persistence);
    const { run, bot, room, connection, binding, adapter, writer, saved, workspace } = execution;
    const cutoff = task.kind ? 0 : (saved?.cutoff ?? writer.current.sequence - 1);
    const scope: RunResultScope = { run, task, binding, writer, cutoff };
    const token = randomBytes(32).toString('base64url');
    const toolContext = this.tools.context(run, task, bot, room, workspace, signal);
    if (saved)
      toolContext.resumeOperations = restoreProgressTools(
        this.state.storage,
        task,
        saved,
        toolContext,
      );
    this.attachReplyBoundaries(toolContext, writer);
    toolContext.getSecret = (ref) => this.vault.get(ref);
    this.nativeContexts.set(token, { context: toolContext, bot, runId: run.id });

    let summaryUsage: () => Usage | undefined = () => undefined;
    let inferenceStarted: number | undefined;
    try {
      if (connection.status !== 'ready') throw new Error('请先在连接页完成登录与连接测试');
      if (
        task.kind === 'context-compaction' &&
        !['chatgpt', 'custom'].includes(connection.provider)
      )
        throw new Error('此通道的上下文由原生运行时管理');
      const prepared = await this.preparation.prepare({
        ...execution,
        task,
        toolContext,
        token,
        signal,
        coreUrl: this.coreUrl,
      });
      summaryUsage = prepared.summaryUsage;
      if (task.kind === 'context-compaction') {
        this.results.completeCompaction(scope, prepared.compaction!, summaryUsage());
        return;
      }
      inferenceStarted = Date.now();
      const result = await adapter.run(prepared.input);
      writer.close();
      const duration = Date.now() - inferenceStarted;
      await this.settleOutput(run, token, signal);
      if (result.outcome === 'waiting_input' || this.tools.waiting(run.id)) {
        this.results.waitForInput(
          scope,
          prepared.input,
          { ...result, text: writer.finalText(result.text) },
          duration,
          summaryUsage(),
        );
        return;
      }
      this.results.complete(scope, prepared, result, duration, summaryUsage());
    } catch (error) {
      try {
        writer.close();
      } catch (writeError) {
        error = writeError;
      }
      const hadActiveProcess = this.tools.processes.hasActiveRun(run.id);
      this.nativeContexts.delete(token);
      await this.tools.settle(run.id);
      await this.tools.processes.settleRun(run.id);
      const duration = inferenceStarted === undefined ? undefined : Date.now() - inferenceStarted;
      if (this.tools.waiting(run.id)) {
        this.results.waitForInput(
          scope,
          undefined,
          { text: '', usage: { source: 'unknown' } },
          duration,
          summaryUsage(),
        );
        return;
      }
      if (this.results.recover(scope, error, signal, hadActiveProcess, duration, summaryUsage()))
        return;
      this.results.fail(scope, error, callerSignal, summaryUsage(), duration);
      if (task.kind === 'question-decision' && !signal.aborted)
        this.questionDecisionFailed(task, publicError(error));
    } finally {
      await this.tools.processes.settleRun(run.id);
      this.inputs.release(run.id);
      this.tools.releaseRun(run.id);
      this.nativeContexts.delete(token);
      this.state.changed();
    }
  }

  private startRun(task: Task, persistence: AbortController) {
    const s = this.state.storage;
    let bot = required(s.get<Bot>('bots', task.botId), '智能体不存在');
    const room = required(s.get<Conversation>('conversations', task.conversationId), '对话不存在');
    const connection = required(
      s.get<Connection>('connections', bot.connectionId),
      '请先为智能体配置连接',
    );
    bot = {
      ...bot,
      model: room.chiefId === bot.id ? (room.model ?? bot.model) : bot.model,
      reasoning: room.chiefId === bot.id && room.model ? room.reasoning : bot.reasoning,
    };
    if (!bot.model) throw new Error('请先为智能体选择模型');
    const workspace = required(s.get<Workspace>('workspaces', room.workspaceId), '工作目录不存在');
    const adapter = required(
      this.adapters.find((item) => item.kind === connection.provider),
      '连接类型不支持',
    );
    let purpose: 'memory' | 'question-decision' | undefined;
    if (task.kind === 'memory-review') purpose = 'memory';
    else if (task.kind === 'question-decision') purpose = 'question-decision';
    const binding = sessionBinding(
      this.state,
      bot,
      room,
      connection,
      workspace,
      purpose,
      task.questionId,
    );
    const saved = loadManagedProgress(s, task, binding);
    const run: Run = {
      id: id(),
      taskId: task.id,
      botId: bot.id,
      bindingId: binding.id,
      status: 'running',
      configRevision: bot.revision,
      connectionId: connection.id,
      model: bot.model,
      createdAt: now(),
      ...(['chatgpt', 'custom'].includes(connection.provider)
        ? { metrics: emptyRunMetrics(), modelRequestCount: 0 }
        : {}),
      ...(!task.kind ? { requirementVersion: receivedRequirementVersion(s, task) } : {}),
      ...(saved ? { resumeFromRunId: task.resumeFromRunId } : {}),
    };
    const writer = s.transaction(() => {
      s.put('runs', run);
      this.tasks.update(task, {
        status: 'running',
        runIds: [...task.runIds, run.id],
        recovery: undefined,
        resumeFromRunId: undefined,
      });
      if (saved) restoreProgressInputs(s, run, saved);
      return RunReplyWriter.create(
        s,
        run,
        room.id,
        !!task.kind,
        saved,
        (error) => persistence.abort(error),
        () => this.state.changed(),
      );
    });
    return { run, bot, room, connection, binding, adapter, writer, saved, workspace };
  }

  private attachReplyBoundaries(context: ToolExecutionContext, writer: RunReplyWriter) {
    const postMessage = context.postMessage;
    context.postMessage = (...args) => {
      writer.flush();
      const result = postMessage(...args);
      writer.next();
      return result;
    };
    const askUser = context.askUser;
    if (askUser)
      context.askUser = (...args) => {
        writer.flush();
        return askUser(...args);
      };
  }

  private async settleOutput(run: Run, token: string, signal: AbortSignal) {
    this.nativeContexts.delete(token);
    await this.tools.settle(run.id);
    this.tools.assertNativeSettled(run.id);
    signal.throwIfAborted();
    if (await this.tools.processes.settleRun(run.id))
      throw new Error('模型结束时仍有命令运行，已停止命令；任务尚未完成');
  }
}
