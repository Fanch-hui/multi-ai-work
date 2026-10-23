import { toolConfiguration } from '../domain/tool-connection.js';
import type {
  Bot,
  Connection,
  Conversation,
  Run,
  Task,
  ToolConnection,
  Workspace,
} from '../domain/types.js';
import type { ToolExecutionContext, ToolRegistry } from '../domain/tools.js';
import type { ToolDefinition } from '../domain/provider.js';
import { MemoryService } from '../runtime/memory.js';
import { ApprovalService } from './approvals.js';
import { TaskService } from './tasks.js';
import { State, id, now } from './state.js';
import { TeamService } from './team.js';
import { MemoryManagement } from './memories.js';
import { ProcessService } from './processes.js';
import { QuestionService } from './questions.js';
import { chiefOnlyTools } from '../domain/tool-permissions.js';
import { storeToolMedia } from './tool-media.js';
import { authorizedSkills } from './skills.js';
import { waitOperation } from './wait-operation.js';
import { enabledQoderServices } from '../domain/qoder-services.js';
import { QoderNativeTools } from './qoder-native-tools.js';
import { TaskPlanService } from './task-plans.js';
import type { TaskControlService } from './task-control.js';
import { prepareWebToolResult } from './web-tool-result.js';
import { ToolTiming } from './tool-timing.js';
import { ToolOperationJournal, type ToolCall } from './tool-operation-journal.js';
import { ContextReferences } from './context-references.js';
import { ToolContextFactory } from './tool-context.js';
import { TaskWaitService } from './task-waits.js';

export class ToolRuntime {
  extensions?: Pick<
    ToolExecutionContext,
    | 'executeBrowser'
    | 'manageRoutines'
    | 'recordArtifactReview'
    | 'saveWorkSkill'
    | 'connectorDrafts'
    | 'executeComputer'
    | 'requestCollaboration'
    | 'resolveCollaboration'
  >;
  private writeLocks = new Map<string, Promise<unknown>>();
  private pending = new Map<string, Set<Promise<unknown>>>();
  private contexts: ToolContextFactory;
  private inputControllers = new Map<string, AbortController>();
  private qoderTools = new Map<string, QoderNativeTools>();
  readonly processes: ProcessService;
  readonly questions: QuestionService;
  readonly plans: TaskPlanService;
  readonly waits: TaskWaitService;
  controls?: TaskControlService;
  constructor(
    private state: State,
    private registry: ToolRegistry,
    tasks: TaskService,
    approvals: ApprovalService,
    memory: MemoryService,
    team: TeamService,
    memoryManagement: MemoryManagement,
  ) {
    this.processes = new ProcessService(state);
    this.questions = new QuestionService(state);
    this.waits = new TaskWaitService(state);
    this.plans = new TaskPlanService(state);
    this.contexts = new ToolContextFactory(
      state,
      tasks,
      approvals,
      memory,
      team,
      memoryManagement,
      this.processes,
      this.questions,
      this.plans,
    );
  }

  inputSignal(runId: string) {
    const controller = this.inputControllers.get(runId) ?? new AbortController();
    this.inputControllers.set(runId, controller);
    return controller.signal;
  }
  waiting(runId: string) {
    return !!(this.questions.forRun(runId) || this.waits.forRun(runId));
  }
  yieldInput(runId: string) {
    if (this.waiting(runId)) this.inputControllers.get(runId)?.abort();
  }
  releaseRun(runId: string) {
    this.qoderTools.get(runId)?.close();
    this.qoderTools.delete(runId);
    this.contexts.release(runId);
    this.inputControllers.delete(runId);
    this.registry.release?.(runId);
  }
  nativeTools(context: ToolExecutionContext, bot: Bot) {
    const tools = new QoderNativeTools(this.state, context, bot, () =>
      this.acquireNativeWrite(context),
    );
    this.qoderTools.set(context.runId, tools);
    return tools;
  }
  assertNativeSettled(runId: string) {
    this.qoderTools.get(runId)?.assertSettled();
  }
  async prepare(context: ToolExecutionContext, bot: Bot) {
    if (context.task.kind || !bot.toolNames.includes('call_mcp')) return;
    const configurations = new Map(
      context.toolConnections.map((connection) => [connection.id, toolConfiguration(connection)]),
    );
    await this.registry.prepare?.(context);
    for (const connection of context.toolConnections) {
      const current = this.state.storage.get<ToolConnection>('tool_connections', connection.id);
      if (
        current &&
        current.enabled &&
        bot.toolConnectionIds?.includes(current.id) &&
        toolConfiguration(current) === configurations.get(connection.id)
      )
        this.state.storage.put('tool_connections', {
          ...current,
          toolNames: connection.toolNames,
          status: connection.status,
          error: connection.error,
          searchBackend: connection.searchBackend,
        });
    }
    this.state.changed();
  }

  context(
    run: Run,
    task: Task,
    bot: Bot,
    room: Conversation,
    workspace: Workspace,
    signal: AbortSignal,
  ): ToolExecutionContext {
    return Object.assign(
      this.contexts.create(run, task, bot, room, workspace, signal, this.controls),
      this.extensions,
    );
  }

  definitions(context: ToolExecutionContext, bot: Bot): ToolDefinition[] {
    if (context.task.kind === 'question-decision') return [];
    return this.registry
      .definitions(context)
      .filter(
        (tool) =>
          (bot.toolNames.includes(tool.name) ||
            tool.name === 'read_skill' ||
            (tool.name === 'scan_code_security' &&
              !!context.scanCodeSecurity &&
              enabledQoderServices(bot).includes('SecurityScan')) ||
            (tool.name.startsWith('mcp__') && bot.toolNames.includes('call_mcp')) ||
            (tool.name === 'manage_memory' && bot.memoryMode !== 'off')) &&
          (context.task.kind !== 'memory-review' || tool.name === 'manage_memory') &&
          (!chiefOnlyTools.includes(tool.name) ||
            (bot.id === this.state.settings().mainBotId &&
              context.conversation.chiefId === bot.id)) &&
          (bot.memoryMode !== 'off' || tool.name !== 'recall_memory') &&
          (tool.name !== 'render_document' ||
            (bot.toolNames.includes('run_command') &&
              bot.toolNames.includes('register_artifact'))) &&
          (tool.name !== 'search_web' ||
            bot.toolNames.includes('call_mcp') ||
            context.toolConnections.some((item) => item.kind === 'search')) &&
          (bot.memoryMode === 'propose' || tool.name !== 'propose_memory'),
      );
  }

  async currentDefinitions(
    context: ToolExecutionContext,
    botId: string,
  ): Promise<ToolDefinition[]> {
    const bot = this.state.storage.get<Bot>('bots', botId);
    if (!bot || bot.archived) return [];
    await this.prepare(this.currentContext(context, bot), bot);
    const latest = this.state.storage.get<Bot>('bots', botId);
    return latest && !latest.archived
      ? this.definitions(this.currentContext(context, latest), latest)
      : [];
  }

  private currentContext(context: ToolExecutionContext, bot: Bot): ToolExecutionContext {
    const s = this.state.storage;
    return {
      ...context,
      conversation:
        s.get<Conversation>('conversations', context.conversation.id) ?? context.conversation,
      workspace: {
        ...context.workspace,
        writable:
          context.workspace.writable &&
          !!s.get<Workspace>('workspaces', context.workspace.id)?.writable,
      },
      toolConnections: s
        .all<ToolConnection>('tool_connections')
        .filter((item) => item.enabled && bot.toolConnectionIds?.includes(item.id)),
      skills: authorizedSkills(this.state, bot),
    };
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    context: ToolExecutionContext,
    bot: Bot,
  ): Promise<unknown> {
    const timing = new ToolTiming();
    const operation = this.executeOperation(name, args, callId, context, bot, timing).finally(
      () => {
        if (context.signal.aborted) timing.status = 'cancelled';
        timing.finish(name, callId, (event) => {
          this.state.storage.event({ id: id(), runId: context.runId, ...event, createdAt: now() });
          this.state.changed('content');
        });
      },
    );
    const pending = this.pending.get(context.runId) ?? new Set();
    pending.add(operation);
    this.pending.set(context.runId, pending);
    void operation
      .finally(() => {
        pending.delete(operation);
        if (!pending.size) this.pending.delete(context.runId);
      })
      .catch(() => {});
    return operation;
  }
  async settle(runId: string) {
    await Promise.allSettled([...(this.pending.get(runId) ?? [])]);
  }

  private async executeOperation(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    context: ToolExecutionContext,
    bot: Bot,
    timing: ToolTiming,
  ): Promise<unknown> {
    const { call, currentBot } = this.authorizeCall(name, args, callId, context, bot, timing);
    const journal = new ToolOperationJournal(this.state, call);
    const lookup = journal.lookup();
    if (lookup.kind === 'reused') return lookup.result;
    if (this.waiting(call.context.runId)) throw new Error('本轮正在等待人工处理，此调用未执行');
    const operation = journal.start(lookup);
    const queuedAt = performance.now();
    let dispatched = false;
    try {
      const rawResult = await this.dispatchCall(call, queuedAt, () => {
        dispatched = true;
        journal.dispatched(operation);
      });
      const result = await timing.measureAsync('processingMs', () =>
        storeToolMedia(rawResult, call.context, this.state.dataDirectory),
      );
      journal.complete(operation, result);
      const modelResult = await this.prepareModelResult(call, currentBot, result);
      journal.finish(operation, result, modelResult);
      return this.waitResult(call.context.runId, modelResult);
    } catch (error) {
      return this.waitResult(call.context.runId, journal.fail(operation, error, dispatched));
    }
  }

  private waitResult(runId: string, result: unknown) {
    const wait = this.waits.forRun(runId);
    if (!wait) return result;
    return {
      ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }),
      waitingForInput: true,
      waitId: wait.id,
    };
  }

  private authorizeCall(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    context: ToolExecutionContext,
    bot: Bot,
    timing: ToolTiming,
  ) {
    const authorizationStart = performance.now();
    context.signal.throwIfAborted();
    if (context.task.kind === 'question-decision') throw new Error('主管代答任务仅可决定回答');
    const currentBot = this.state.storage.get<Bot>('bots', bot.id);
    if (!currentBot || currentBot.archived) throw new Error('智能体已归档');
    context = this.currentContext(context, currentBot);
    const requestedName = name;
    const availableNames = new Set(this.definitions(context, currentBot).map((tool) => tool.name));
    if (!availableNames.has(requestedName)) throw new Error(`当前未授权工具：${requestedName}`);
    const canonical = this.registry.canonical?.(name, args, context);
    if (canonical) {
      name = canonical.name;
      args = canonical.args;
    }
    if (
      name === 'search_web' &&
      context.toolConnections.find((item) => item.id === args.connectionId)?.kind !== 'search' &&
      !currentBot.toolNames.includes('call_mcp')
    )
      throw new Error('MCP 搜索需要外部工具权限及连接授权');
    if (!availableNames.has(name)) throw new Error(`当前未授权工具：${name}`);
    timing.record('authorizationMs', performance.now() - authorizationStart);
    return {
      call: { name, requestedName, botId: bot.id, args, callId, context, timing },
      currentBot,
    };
  }

  private assertCallAuthorized({ name, requestedName, botId, args, context, timing }: ToolCall) {
    timing.measure('authorizationMs', () => {
      context.signal.throwIfAborted();
      const latestBot = this.state.storage.get<Bot>('bots', botId);
      if (!latestBot || latestBot.archived) throw new Error(`当前未授权工具：${name}`);
      const latestContext = this.currentContext(context, latestBot);
      if (
        [
          'write_artifact',
          'write_file',
          'edit_file',
          'delete_file',
          'run_command',
          'render_document',
        ].includes(name) &&
        !latestContext.workspace.writable
      )
        throw new Error('工作目录仅允许读取');
      const authorizedNames = new Set(
        this.definitions(latestContext, latestBot).map((tool) => tool.name),
      );
      if (!authorizedNames.has(requestedName) || !authorizedNames.has(name))
        throw new Error(`当前未授权工具：${name}`);
      if (
        ['call_mcp', 'search_web'].includes(name) &&
        (typeof args.connectionId !== 'string' ||
          !latestBot.toolConnectionIds?.includes(args.connectionId) ||
          !this.state.storage.get<ToolConnection>('tool_connections', args.connectionId)?.enabled)
      )
        throw new Error('外部连接未授权');
    });
  }

  private async dispatchCall(call: ToolCall, queuedAt: number, markDispatched: () => void) {
    const { name, args, callId, context, timing } = call;
    const rawRequestApproval = context.requestApproval;
    const writesWorkspace = [
      'write_artifact',
      'write_file',
      'edit_file',
      'delete_file',
      'run_command',
      'render_document',
      'scan_code_security',
    ].includes(name);
    if (writesWorkspace && this.processes.hasActiveRun(context.runId))
      throw new Error('当前任务有活跃命令，请先完成或停止该命令');
    const execute = () => {
      if (writesWorkspace) timing.record('workspaceQueueMs', performance.now() - queuedAt);
      if (this.waiting(context.runId)) throw new Error('本轮正在等待人工处理，此调用未执行');
      const executionContext: ToolExecutionContext = {
        ...context,
        callId,
        recordTiming: (stage, durationMs) => timing.record(stage, durationMs),
        requestApproval: async (action, summary, details) => {
          const approved = await timing.measureAsync('approvalWaitMs', () =>
            rawRequestApproval(action, summary, details),
          );
          if (approved) this.assertCallAuthorized(call);
          return approved;
        },
        assertAuthorized: () => this.assertCallAuthorized(call),
        markDispatched: () => {
          this.assertCallAuthorized(call);
          markDispatched();
        },
      };
      executionContext.processes = this.processes.forContext(executionContext);
      Object.assign(executionContext, this.controls?.forContext(executionContext));
      return timing.measureAsync('executionMs', () =>
        this.registry.execute(name, args, executionContext),
      );
    };
    if (!writesWorkspace) return execute();
    return this.withWriteLock(
      context.workspace.id,
      async () => {
        await this.processes.waitForWorkspace(context.workspace.id, context.runId, context.signal);
        return execute();
      },
      context.signal,
    );
  }

  private async prepareModelResult(call: ToolCall, bot: Bot, result: unknown) {
    const { name, args, context, callId, timing } = call;
    const provider = this.state.storage.get<Connection>('connections', bot.connectionId)?.provider;
    return timing.measureAsync('processingMs', async () => {
      const resultContext = { ...context, callId };
      const preview = await prepareWebToolResult(
        this.state,
        resultContext,
        bot,
        name,
        args,
        result,
      );
      if (provider === 'chatgpt' || provider === 'custom') return preview;
      return this.compactResult(preview, resultContext, bot, name);
    });
  }
  private async acquireNativeWrite(context: ToolExecutionContext): Promise<() => void> {
    let release!: () => void, grant!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const cancel = () => release();
    context.signal.addEventListener('abort', cancel, { once: true });
    const operation = this.withWriteLock(
      context.workspace.id,
      async () => {
        await this.processes.waitForWorkspace(context.workspace.id, context.runId, context.signal);
        grant();
        await released;
      },
      context.signal,
    );
    void operation
      .finally(() => context.signal.removeEventListener('abort', cancel))
      .catch(() => {});
    await Promise.race([
      granted,
      operation.then(() => {
        throw new Error('图片生成已取消');
      }),
    ]);
    return release;
  }
  private async withWriteLock(key: string, action: () => Promise<unknown>, signal: AbortSignal) {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted();
        return action();
      });
    this.writeLocks.set(key, current);
    void current
      .finally(() => {
        if (this.writeLocks.get(key) === current) this.writeLocks.delete(key);
      })
      .catch(() => {});
    return waitOperation(current, signal);
  }
  private async compactResult(
    result: unknown,
    context: ToolExecutionContext,
    bot: Bot,
    name: string,
  ): Promise<unknown> {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (!text || text.length <= 32000 || name === 'read_artifact') return result;
    const references = new ContextReferences(this.state, {
      runId: context.runId,
      task: context.task,
      bot,
      room: context.conversation,
      toolNames: bot.toolNames,
      signal: context.signal,
    });
    const reference = await references.preserveToolOutput({
      role: 'tool',
      callId: context.callId,
      content: text,
    });
    if (!reference) return result;
    return {
      content: text.slice(0, 12000),
      truncated: true,
      artifactId: reference.id,
      totalLength: text.length,
      instruction: '完整结果已保存，可用 read_artifact 的 offset 分段读取。',
    };
  }
}
