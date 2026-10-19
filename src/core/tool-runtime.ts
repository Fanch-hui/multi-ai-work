import { createHash } from 'node:crypto';
import { toolConfiguration } from '../domain/tool-connection.js';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact, Bot, Connection, Conversation, MemoryEntry, Run, Task, ToolConnection, Workspace } from '../domain/types.js';
import type { TaskGroupInput, ToolExecutionContext, ToolRegistry } from '../domain/tools.js';
import type { ToolDefinition } from '../domain/provider.js';
import { MemoryService } from '../runtime/memory.js';
import { ApprovalService } from './approvals.js';
import { TaskService } from './tasks.js';
import { State, id, now } from './state.js';
import { publicError } from './errors.js';
import { TeamService } from './team.js';
import { MemoryManagement } from './memories.js';
import { accessibleArtifacts, messageTools, ownsTaskFile } from './tool-access.js';
import { ProcessService } from './processes.js';
import { QuestionService } from './questions.js';
import { toolSummary } from './tool-summary.js';
import { chiefOnlyTools } from '../domain/tool-permissions.js';
import { storeToolMedia } from './tool-media.js';
import { authorizedSkills } from './skills.js';
import { inspectTask } from './task-inspection.js';
import { waitOperation } from './wait-operation.js';
import { enabledQoderServices } from '../domain/qoder-services.js';
import { QoderNativeTools } from './qoder-native-tools.js';
import { scanQoderSecurity } from './qoder-security-scan.js';
import { TaskPlanService } from './task-plans.js';
import { scopedTask, returnTaskArtifacts } from './task-access.js';
import { artifactRequirement } from './task-requirements.js';
import type { TaskControlService } from './task-control.js';
import { assertUserMemorySources } from './memory-policy.js';
import { prepareWebToolResult } from './web-tool-result.js';
import { ToolTiming } from './tool-timing.js';
import { ContextReferences } from './context-references.js';

interface Operation { id: string; fingerprint: string; runId: string; name: string; status: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'unknown'; result?: unknown; modelResult?: unknown; error?: string; errorCode?: string; requirementVersion?: number; }
export class ToolRuntime {
  private writeLocks = new Map<string, Promise<unknown>>();
  private pending = new Map<string, Set<Promise<unknown>>>();
  private observations = new Map<string, Map<string, string>>();
  private inputControllers = new Map<string, AbortController>();
  private qoderTools = new Map<string, QoderNativeTools>();
  readonly processes: ProcessService;
  readonly questions: QuestionService;
  readonly plans: TaskPlanService;
  controls?: TaskControlService;
  constructor(private state: State, private registry: ToolRegistry, private tasks: TaskService,
    private approvals: ApprovalService, private memory: MemoryService, private team: TeamService,
    private memoryManagement: MemoryManagement) {
    this.processes = new ProcessService(state); this.questions = new QuestionService(state); this.plans = new TaskPlanService(state);
  }

  inputSignal(runId: string) {
    const controller = this.inputControllers.get(runId) ?? new AbortController();
    this.inputControllers.set(runId, controller); return controller.signal;
  }
  yieldInput(runId: string) { if (this.questions.forRun(runId)) this.inputControllers.get(runId)?.abort(); }
  releaseRun(runId: string) {
    this.qoderTools.get(runId)?.close(); this.qoderTools.delete(runId);
    this.observations.delete(runId); this.inputControllers.delete(runId); this.registry.release?.(runId);
  }
  nativeTools(context: ToolExecutionContext, bot: Bot) {
    const tools = new QoderNativeTools(this.state, context, bot, () => this.acquireNativeWrite(context));
    this.qoderTools.set(context.runId, tools); return tools;
  }
  assertNativeSettled(runId: string) { this.qoderTools.get(runId)?.assertSettled(); }
  async prepare(context: ToolExecutionContext, bot: Bot) {
    if (context.task.kind || !bot.toolNames.includes('call_mcp')) return;
    const configurations = new Map(context.toolConnections.map(connection => [connection.id, toolConfiguration(connection)]));
    await this.registry.prepare?.(context);
    for (const connection of context.toolConnections) {
      const current = this.state.storage.get<ToolConnection>('tool_connections', connection.id);
      if (current && current.enabled && bot.toolConnectionIds?.includes(current.id) && toolConfiguration(current) === configurations.get(connection.id))
        this.state.storage.put('tool_connections', { ...current, toolNames: connection.toolNames,
          status: connection.status, error: connection.error, searchBackend: connection.searchBackend });
    }
    this.state.changed();
  }

  context(run: Run, task: Task, bot: Bot, room: Conversation, workspace: Workspace, signal: AbortSignal): ToolExecutionContext {
    const s = this.state.storage;
    const context: ToolExecutionContext = { runId: run.id, task, botId: bot.id, conversation: room, workspace, signal,
      requestApproval: (name, summary, args) => this.approvals.request(run, name, summary, args, signal),
      listArtifacts: () => accessibleArtifacts(this.state, room, bot.id, s.get<Task>('tasks', task.id) ?? task).map(artifact => artifactRequirement(s, artifact)),
      findArtifact: artifactId => {
        const artifact = accessibleArtifacts(this.state, room, bot.id, s.get<Task>('tasks', task.id) ?? task).find(artifact => artifact.id === artifactId);
        return artifact && artifactRequirement(s, artifact);
      },
      readArtifact: async artifactId => {
        signal.throwIfAborted();
        const currentBot = s.get<Bot>('bots', bot.id);
        if (!currentBot || currentBot.archived || !currentBot.toolNames.includes('read_artifact')) throw new Error('资料不存在或未授权');
        const currentRoom = s.get<Conversation>('conversations', room.id);
        const artifact = currentRoom && accessibleArtifacts(this.state, currentRoom, bot.id, s.get<Task>('tasks', task.id) ?? task)
          .find(item => item.id === artifactId);
        if (!artifact) throw new Error('资料不存在或未授权');
        return this.state.artifactContents.read(artifact);
      },
      ...messageTools(this.state, room.id),
      getObservedFileVersion: path => this.observations.get(run.id)?.get(path),
      observeFile: (path, version) => { const files = this.observations.get(run.id) ?? new Map<string, string>(); files.set(path, version); this.observations.set(run.id, files); },
      ownsFile: (path, version) => ownsTaskFile(this.state, task, path, version),
      ...(!task.kind ? { askUser: (input: Parameters<QuestionService['create']>[0]) => {
        if (this.processes.hasActiveRun(run.id)) throw new Error('请先完成或停止本任务的活跃命令');
        return this.questions.create(input, context);
      } } : {}),
      registerArtifact: input => {
        const artifactId = id();
        const directory = join(this.state.dataDirectory, 'artifacts', artifactId);
        mkdirSync(directory, { recursive: true });
        const path = join(directory, input.name); copyFileSync(input.path, path);
        const artifact: Artifact = { ...input, id: artifactId, path, workingPath: input.workingPath ?? (input.source ? undefined : input.path),
          taskId: task.id, botId: bot.id, conversationId: room.id, createdAt: now(),
          requirementVersion: input.requirementVersion ?? s.get<Run>('runs', run.id)?.requirementVersion };
        s.transaction(() => { s.put('artifacts', artifact); const current = s.get<Task>('tasks', task.id)!; s.put('tasks', { ...current, artifactIds: [...current.artifactIds, artifact.id] }); });
        this.state.changed(); return artifact;
      },
      postMessage: (content, artifacts, conversationId) => this.tasks.post(room.id, bot.id, run.id, content, artifacts, conversationId).id,
      delegateTask: (botId, goal, expectedOutput, dependencyIds, artifactIds, planStepId) => this.tasks.create({ botId, goal, expectedOutput,
        parentId: task.id, conversationId: room.id, dependencyIds, inputArtifactIds: artifactIds ?? s.get<Task>('tasks', task.id)?.inputArtifactIds,
        planStepId, requestId: createHash('sha256').update(JSON.stringify({ parentId: task.id, botId, goal, expectedOutput, planStepId,
          artifacts: [...artifactIds ?? s.get<Task>('tasks', task.id)?.inputArtifactIds ?? []].sort(), dependencies: [...dependencyIds ?? []].sort() })).digest('hex') }),
      getTask: taskId => {
        const target = scopedTask(this.state, room, bot.id, taskId);
        if (!target) return undefined;
        const inspected = inspectTask(this.state, target);
        returnTaskArtifacts(this.state, room, bot.id, target, inspected.artifactIds);
        return inspected;
      },
      ...(bot.id === this.state.settings().mainBotId && room.chiefId === bot.id ? {
        listBots: () => this.team.catalog(), configureBot: (input: Record<string, unknown>) => this.team.configureMember(input),
        ...(!task.kind ? { setTaskPlan: input => this.plans.set(task, input), getTaskPlan: () => this.plans.get(task),
          updatePlanStep: input => this.plans.update(task, input) } : {}),
        ...(room.purpose === 'chief' && room.kind === 'private' ? {
          createTaskGroup: (input: TaskGroupInput) => this.team.createTaskGroup(task, input),
        } : {}),
      } : {}),
      recallMemory: input => bot.memoryMode === 'off' ? [] : this.memory.query({ botId: bot.id, conversationId: room.id }, input, { recordActiveRead: !task.kind, scopeKey: run.id }),
      ...(bot.memoryMode !== 'off' ? { manageMemory: (input: Record<string, unknown>) => this.memoryManagement.manage(input, bot.id, room.id, task) } : {}),
      proposeMemory: (content, scope, sourceIds, metadata) => {
        if (bot.memoryMode === 'off') throw new Error('当前智能体已关闭记忆');
        if (scope === 'shared') throw new Error('请先保存当前会话记忆，再由管家设置共享范围');
        assertUserMemorySources(this.state, sourceIds, [room.id]);
        const memory = this.memory.propose({ botId: bot.id, conversationId: room.id, content, scope, sourceIds, ...metadata });
        if (scope === 'bot' || bot.id === this.state.settings().mainBotId)
          return this.memoryManagement.manage({ action: 'approve', id: memory.id }, bot.id, room.id, task) as MemoryEntry;
        this.state.changed(); return memory;
      },
      getSecret: async () => { throw new Error('工具凭据服务尚未绑定'); },
      defaultSearchConnectionId: this.state.settings().defaultSearchConnectionId,
      toolConnections: s.all<ToolConnection>('tool_connections').filter(item => item.enabled && bot.toolConnectionIds?.includes(item.id)),
      skills: authorizedSkills(this.state, bot),
    };
    context.processes = this.processes.forContext(context);
    Object.assign(context, this.controls?.forContext(context));
    if (!task.kind && s.get<Connection>('connections', bot.connectionId)?.provider === 'qoder' && enabledQoderServices(bot).includes('SecurityScan'))
      context.scanCodeSecurity = input => scanQoderSecurity(input, context, this.state, this.processes);
    return context;
  }

  definitions(context: ToolExecutionContext, bot: Bot): ToolDefinition[] {
    if (context.task.kind === 'question-decision') return [];
    return this.registry.definitions(context).filter(tool => (bot.toolNames.includes(tool.name) || tool.name === 'read_skill'
        || tool.name === 'scan_code_security' && !!context.scanCodeSecurity && enabledQoderServices(bot).includes('SecurityScan')
        || tool.name.startsWith('mcp__') && bot.toolNames.includes('call_mcp')
        || tool.name === 'manage_memory' && bot.memoryMode !== 'off')
      && (context.task.kind !== 'memory-review' || tool.name === 'manage_memory')
      && (!chiefOnlyTools.includes(tool.name) || bot.id === this.state.settings().mainBotId && context.conversation.chiefId === bot.id)
      && (bot.memoryMode !== 'off' || tool.name !== 'recall_memory')
      && (tool.name !== 'render_document' || bot.toolNames.includes('run_command') && bot.toolNames.includes('register_artifact'))
      && (tool.name !== 'search_web' || bot.toolNames.includes('call_mcp') || context.toolConnections.some(item => item.kind === 'search'))
      && (bot.memoryMode === 'propose' || tool.name !== 'propose_memory'));
  }

  async currentDefinitions(context: ToolExecutionContext, botId: string): Promise<ToolDefinition[]> {
    const bot = this.state.storage.get<Bot>('bots', botId);
    if (!bot || bot.archived) return [];
    await this.prepare(this.currentContext(context, bot), bot);
    const latest = this.state.storage.get<Bot>('bots', botId);
    return latest && !latest.archived ? this.definitions(this.currentContext(context, latest), latest) : [];
  }

  private currentContext(context: ToolExecutionContext, bot: Bot): ToolExecutionContext {
    const s = this.state.storage;
    return { ...context,
      conversation: s.get<Conversation>('conversations', context.conversation.id) ?? context.conversation,
      workspace: { ...context.workspace, writable: context.workspace.writable && !!s.get<Workspace>('workspaces', context.workspace.id)?.writable },
      toolConnections: s.all<ToolConnection>('tool_connections').filter(item => item.enabled && bot.toolConnectionIds?.includes(item.id)),
      skills: authorizedSkills(this.state, bot) };
  }

  execute(name: string, args: Record<string, unknown>, callId: string, context: ToolExecutionContext, bot: Bot): Promise<unknown> {
    const timing = new ToolTiming();
    const operation = this.executeOperation(name, args, callId, context, bot, timing).finally(() => {
      if (context.signal.aborted) timing.status = 'cancelled';
      timing.finish(name, callId, event => {
        this.state.storage.event({ id: id(), runId: context.runId, ...event, createdAt: now() });
        this.state.changed('content');
      });
    });
    const pending = this.pending.get(context.runId) ?? new Set();
    pending.add(operation); this.pending.set(context.runId, pending);
    void operation.finally(() => { pending.delete(operation); if (!pending.size) this.pending.delete(context.runId); }).catch(() => {});
    return operation;
  }
  async settle(runId: string) { await Promise.allSettled([...(this.pending.get(runId) ?? [])]); }

  private async executeOperation(name: string, args: Record<string, unknown>, callId: string, context: ToolExecutionContext, bot: Bot, timing: ToolTiming): Promise<unknown> {
    const authorizationStart = performance.now();
    context.signal.throwIfAborted();
    if (context.task.kind === 'question-decision') throw new Error('主管代答任务仅可决定回答');
    const currentBot = this.state.storage.get<Bot>('bots', bot.id);
    if (!currentBot || currentBot.archived) throw new Error('智能体已归档');
    context = this.currentContext(context, currentBot);
    const requestedName = name;
    const availableNames = new Set(this.definitions(context, currentBot).map(tool => tool.name));
    if (!availableNames.has(requestedName)) throw new Error(`当前未授权工具：${requestedName}`);
    const canonical = this.registry.canonical?.(name, args, context);
    if (canonical) { name = canonical.name; args = canonical.args; }
    if (name === 'search_web' && context.toolConnections.find(item => item.id === args.connectionId)?.kind !== 'search'
      && !currentBot.toolNames.includes('call_mcp')) throw new Error('MCP 搜索需要外部工具权限及连接授权');
    if (!availableNames.has(name)) throw new Error(`当前未授权工具：${name}`);
    timing.record('authorizationMs', performance.now() - authorizationStart);
    const resumedId = context.resumeOperations?.[callId];
    const operationId = resumedId ?? `${context.runId}:${callId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
    const existing = this.state.storage.get<Operation>('tool_operations', operationId);
    if (resumedId) {
      const source = existing && this.state.storage.get<Run>('runs', existing.runId);
      if (!source || source.taskId !== context.task.id || source.botId !== bot.id)
        throw new Error('恢复的工具操作不属于当前任务');
    }
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('工具调用 ID 与参数不匹配');
      if (existing.status === 'succeeded') { timing.status = 'reused'; return existing.modelResult ?? existing.result; }
      if (resumedId && existing.status === 'failed') return { error: existing.error ?? '工具执行失败' };
      if (!resumedId || existing.status !== 'prepared') throw new Error('工具调用已有执行记录，请先核查实际结果');
    }
    if (this.questions.forRun(context.runId)) throw new Error('本轮正在等待用户回答');
    const operation: Operation = existing ?? { id: operationId, fingerprint, runId: context.runId, name, status: 'prepared',
      requirementVersion: this.state.storage.get<Run>('runs', context.runId)?.requirementVersion };
    const summary = toolSummary(name, args);
    const s = this.state.storage;
    timing.measure('saveMs', () => s.put('tool_operations', operation));
    let dispatched = false;
    s.event({ id: id(), runId: context.runId, type: 'tool', data: { name: requestedName, callId, summary, status: 'running', source: 'app' }, createdAt: now() });
    this.state.changed();
    const queuedAt = performance.now();
    try {
      const rawRequestApproval = context.requestApproval;
      const assertAuthorized = () => timing.measure('authorizationMs', () => {
        context.signal.throwIfAborted();
        const latestBot = this.state.storage.get<Bot>('bots', bot.id);
        if (!latestBot || latestBot.archived) throw new Error(`当前未授权工具：${name}`);
        const latestContext = this.currentContext(context, latestBot);
        if (['write_artifact', 'write_file', 'edit_file', 'delete_file', 'run_command', 'render_document'].includes(name)
          && !latestContext.workspace.writable) throw new Error('工作目录仅允许读取');
        const authorizedNames = new Set(this.definitions(latestContext, latestBot).map(tool => tool.name));
        if (!authorizedNames.has(requestedName) || !authorizedNames.has(name))
          throw new Error(`当前未授权工具：${name}`);
        if (['call_mcp', 'search_web'].includes(name) && (typeof args.connectionId !== 'string' || !latestBot.toolConnectionIds?.includes(args.connectionId)
          || !this.state.storage.get<ToolConnection>('tool_connections', args.connectionId)?.enabled)) throw new Error('外部连接未授权');
      });
      const execute = () => {
        if (writesWorkspace) timing.record('workspaceQueueMs', performance.now() - queuedAt);
        if (this.questions.forRun(context.runId)) throw new Error('本轮正在等待用户回答');
        const executionContext: ToolExecutionContext = { ...context, callId,
          recordTiming: (stage, durationMs) => timing.record(stage, durationMs),
          requestApproval: async (action, approveSummary, details) => {
            const approved = await timing.measureAsync('approvalWaitMs', () => rawRequestApproval(action, approveSummary, details));
            if (approved) assertAuthorized();
            return approved;
          },
          assertAuthorized,
          markDispatched: () => {
            assertAuthorized();
            dispatched = true; timing.measure('saveMs', () => s.put('tool_operations', { ...operation, status: 'dispatched' }));
          } };
        executionContext.processes = this.processes.forContext(executionContext);
        Object.assign(executionContext, this.controls?.forContext(executionContext));
        return timing.measureAsync('executionMs', () => this.registry.execute(name, args, executionContext));
      };
      const mutate = async () => {
        await this.processes.waitForWorkspace(context.workspace.id, context.runId, context.signal);
        return execute();
      };
      const writesWorkspace = ['write_artifact', 'write_file', 'edit_file', 'delete_file', 'run_command', 'render_document', 'scan_code_security'].includes(name);
      if (writesWorkspace && this.processes.hasActiveRun(context.runId)) throw new Error('当前任务有活跃命令，请先完成或停止该命令');
      const rawResult = writesWorkspace
        ? await this.withWriteLock(context.workspace.id, mutate, context.signal)
        : await execute();
      const result = await timing.measureAsync('processingMs', () => storeToolMedia(rawResult, context, this.state.dataDirectory));
      timing.measure('saveMs', () => s.put('tool_operations', { ...operation, status: 'succeeded', result }));
      const command = name === 'run_command' && result && typeof result === 'object' && 'status' in result
        ? { commandStatus: result.status, exitCode: 'code' in result ? result.code : undefined } : {};
      s.event({ id: id(), runId: context.runId, type: 'tool', data: { name, callId, summary, status: 'completed', source: 'app', ...command }, createdAt: now() });
      const provider = s.get<Connection>('connections', currentBot.connectionId)?.provider;
      const modelResult = await timing.measureAsync('processingMs', async () => {
        const resultContext = { ...context, callId };
        const preview = await prepareWebToolResult(this.state, resultContext, currentBot, name, args, result);
        return provider === 'chatgpt' || provider === 'custom' ? preview : this.compactResult(preview, resultContext, currentBot, name);
      });
      timing.measure('saveMs', () => s.put('tool_operations', { ...operation, status: 'succeeded', result, modelResult }));
      timing.status = 'succeeded';
      this.state.changed(); return modelResult;
    } catch (error) {
      const unknown = dispatched && (context.signal.aborted || (name === 'call_mcp' && /unknown|结果未知|ECONNRESET|ETIMEDOUT|closed|timeout|timed out|断开/i.test(publicError(error))));
      const errorCode = name === 'read_artifact' && typeof args.artifactId === 'string'
        ? s.get<Artifact>('artifacts', args.artifactId) ? 'artifact_unauthorized' : 'artifact_missing' : undefined;
      timing.measure('saveMs', () => s.put('tool_operations', { ...operation, status: unknown ? 'unknown' : 'failed', error: publicError(error), errorCode }));
      s.event({ id: id(), runId: context.runId, type: 'tool', data: { name, callId, summary, status: 'failed', source: 'app', error: publicError(error) }, createdAt: now() });
      this.state.changed();
      if (context.signal.aborted) throw error;
      return { error: publicError(error) };
    }
  }
  private async acquireNativeWrite(context: ToolExecutionContext): Promise<() => void> {
    let release!: () => void, grant!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const granted = new Promise<void>(resolve => { grant = resolve; });
    const cancel = () => release();
    context.signal.addEventListener('abort', cancel, { once: true });
    const operation = this.withWriteLock(context.workspace.id, async () => {
      await this.processes.waitForWorkspace(context.workspace.id, context.runId, context.signal);
      grant(); await released;
    }, context.signal);
    void operation.finally(() => context.signal.removeEventListener('abort', cancel)).catch(() => {});
    await Promise.race([granted, operation.then(() => { throw new Error('图片生成已取消'); })]);
    return release;
  }
  private async withWriteLock(key: string, action: () => Promise<unknown>, signal: AbortSignal) {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => { signal.throwIfAborted(); return action(); });
    this.writeLocks.set(key, current);
    void current.finally(() => { if (this.writeLocks.get(key) === current) this.writeLocks.delete(key); }).catch(() => {});
    return waitOperation(current, signal);
  }
  private async compactResult(result: unknown, context: ToolExecutionContext, bot: Bot, name: string): Promise<unknown> {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (!text || text.length <= 32000 || name === 'read_artifact') return result;
    const references = new ContextReferences(this.state, { runId: context.runId, task: context.task, bot,
      room: context.conversation, toolNames: bot.toolNames, signal: context.signal });
    const reference = await references.preserveToolOutput({ role: 'tool', callId: context.callId, content: text });
    if (!reference) return result;
    return { content: text.slice(0, 12000), truncated: true, artifactId: reference.id,
      totalLength: text.length, instruction: '完整结果已保存，可用 read_artifact 的 offset 分段读取。' };
  }
}
