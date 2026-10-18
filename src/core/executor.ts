import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { Bot, Connection, Conversation, Message, Run, SessionBinding, Task, Workspace, Usage } from '../domain/types.js';
import type { ProviderAdapter, RunContext, ProviderResult } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { ContextManager } from '../runtime/context.js';
import type { ModelHistoryEntry } from '../runtime/model-history.js';
import { MemoryService } from '../runtime/memory.js';
import { Vault } from '../security/vault.js';
import { State, id, now } from './state.js';
import { TaskService, terminal } from './tasks.js';
import { ToolRuntime } from './tool-runtime.js';
import { addUsage, prepareManagedContext, workingHistory, projectedHistory, saveHistoryValidity } from './managed-context.js';
import { publicError, required } from './errors.js';
import { memorySelectOptions, runPrompt } from './run-prompt.js';
import { completeRunMessage, interruptRunMessage, runMessageSources } from './run-message.js';
import { sessionBinding } from './session-binding.js';
import { sessionMemory } from './session-memory.js';
import { emptyRunMetrics, recordRunEvent } from './run-metrics.js';
import { modelImage, imageResolver } from './run-images.js';
import { TaskInputService } from './task-inputs.js';
import { receivedRequirementVersion } from './task-requirements.js';
import { loadManagedProgress, restoreProgressTools, restoreProgressInputs, saveManagedProgress,
  type ManagedCheckpoint } from './managed-progress.js';
import { RunReplyWriter } from './run-reply.js';
import { ModelRecoveryPendingError } from '../domain/recovery.js';
import { clearProgressDeltas } from './managed-progress-deltas.js';

export class Executor {
  readonly nativeContexts = new Map<string, { context: ToolExecutionContext; bot: Bot; runId: string }>();
  coreUrl = '';
  private inputs: TaskInputService;
  constructor(private state: State, private tasks: TaskService, private tools: ToolRuntime,
    private memory: MemoryService, private contextManager: ContextManager, private vault: Vault,
    private adapters: ProviderAdapter[]) { this.inputs = new TaskInputService(state); }
  cancelQuestions(task: Task) {
    this.tools.questions.cancelTask(task.id);
    if (task.kind === 'question-decision') this.questionDecisionFailed(task, '主管代答已停止');
  }
  questionDecisionFailed(task: Task, error: string) { this.tools.questions.failDecision(task, error); }

  async execute(task: Task, signal: AbortSignal) {
    const callerSignal = signal;
    const persistence = new AbortController();
    signal = AbortSignal.any([signal, persistence.signal]);
    const s = this.state.storage;
    let bot = required(s.get<Bot>('bots', task.botId), '智能体不存在');
    const room = required(s.get<Conversation>('conversations', task.conversationId), '对话不存在');
    const connection = required(s.get<Connection>('connections', bot.connectionId), '请先为智能体配置连接');
    bot = { ...bot, model: room.chiefId === bot.id ? room.model ?? bot.model : bot.model,
      reasoning: room.chiefId === bot.id && room.model ? room.reasoning : bot.reasoning };
    if (!bot.model) throw new Error('请先为智能体选择模型');
    const workspace = required(s.get<Workspace>('workspaces', room.workspaceId), '工作目录不存在');
    const adapter = required(this.adapters.find(item => item.kind === connection.provider), '连接类型不支持');
    const background = !!task.kind;
    const purpose = task.kind === 'memory-review' ? 'memory' : task.kind === 'question-decision' ? 'question-decision' : undefined;
    const binding = sessionBinding(this.state, bot, room, connection, workspace, purpose, task.questionId);
    const saved = loadManagedProgress(s, task, binding);
    const run: Run = { id: id(), taskId: task.id, botId: bot.id, bindingId: binding.id,
      status: 'running', configRevision: bot.revision, connectionId: connection.id, model: bot.model, createdAt: now(),
      ...(['chatgpt', 'custom'].includes(connection.provider) ? { metrics: emptyRunMetrics(), modelRequestCount: 0 } : {}),
      ...(!background ? { requirementVersion: receivedRequirementVersion(s, task) } : {}),
      ...(saved ? { resumeFromRunId: task.resumeFromRunId } : {}) };
    const draft = s.transaction(() => {
      s.put('runs', run); this.tasks.update(task, { status: 'running', runIds: [...task.runIds, run.id],
        recovery: undefined, resumeFromRunId: undefined });
      if (saved) {
        restoreProgressInputs(s, run, saved);
        const previous = s.getMessage(saved.draftId);
        if (previous && previous.status !== 'committed') {
          const resumed = { ...previous, runId: run.id, content: saved.progress.text.slice(saved.draftPrefixLength ?? 0), status: 'draft' as const };
          s.updateMessage(resumed); return resumed;
        }
      }
      const message: Message = { id: id(), conversationId: room.id, authorType: 'bot', authorBotId: bot.id,
        runId: run.id, content: '', artifactIds: [], status: 'draft', createdAt: now(), sequence: 0 };
      if (saved) {
        const sources = runMessageSources(s, run.id);
        if (s.messages(room.id).some(item => item.sequence > saved.cutoff && item.runId && sources.has(item.runId)
          && item.authorBotId === bot.id && item.status === 'committed')) return message;
      }
      return background ? message : s.appendMessage(message);
    });
    const writer = new RunReplyWriter(s, draft, error => persistence.abort(error), saved?.progress.text);
    const inputCutoff = background ? 0 : saved?.cutoff ?? draft.sequence - 1;
    const token = randomBytes(32).toString('base64url');
    const toolContext = this.tools.context(run, task, bot, room, workspace, signal);
    if (saved) toolContext.resumeOperations = restoreProgressTools(s, task, saved, toolContext);
    const postMessage = toolContext.postMessage;
    toolContext.postMessage = (...args) => { writer.flush(); const result = postMessage(...args); writer.next(); return result; };
    const askUser = toolContext.askUser;
    if (askUser) toolContext.askUser = (...args) => { writer.flush(); return askUser(...args); };
    toolContext.getSecret = ref => this.vault.get(ref);
    this.nativeContexts.set(token, { context: toolContext, bot, runId: run.id });
    let summaryUsage: () => Usage | undefined = () => undefined;
    let inferenceStarted: number | undefined;
    try {
      if (connection.status !== 'ready') throw new Error('请先在连接页完成登录与连接测试');
      if (task.kind === 'context-compaction' && !['chatgpt', 'custom'].includes(connection.provider))
        throw new Error('此通道的上下文由原生运行时管理');
      const prepared = await this.prepare(run, task, bot, room, connection, binding, adapter, toolContext, draft, token, signal, writer, saved);
      const input = prepared.input; summaryUsage = prepared.summaryUsage;
      if (task.kind === 'context-compaction') {
        const compaction = prepared.compaction!;
        writer.close();
        s.transaction(() => {
          s.put('runs', { ...s.get<Run>('runs', run.id)!, status: 'completed', endedAt: now(), usage: summaryUsage() });
          this.tasks.update(task, { status: 'completed', result: compaction.result, contextCompactionOutcome: compaction.outcome });
        });
        return;
      }
      inferenceStarted = Date.now();
      const result = await adapter.run(input);
      writer.close();
      const inferenceDurationMs = Date.now() - inferenceStarted;
      this.nativeContexts.delete(token); await this.tools.settle(run.id);
      this.tools.assertNativeSettled(run.id);
      signal.throwIfAborted();
      if (await this.tools.processes.settleRun(run.id)) throw new Error('模型结束时仍有命令运行，已停止命令；任务尚未完成');
      if (result.outcome === 'waiting_input' || this.tools.questions.forRun(run.id)) {
        this.waitForInput(run, task, binding, draft, inputCutoff, input, { ...result, text: writer.finalText(result.text) }, inferenceDurationMs, summaryUsage()); return;
      }
      const sources = runMessageSources(s, run.id);
      const resultText = result.text.trim() ? result.text : s.messages(room.id)
        .filter(message => message.runId && sources.has(message.runId) && message.authorBotId === bot.id && message.status === 'committed')
        .map(message => message.content).join('\n\n');
      if (!resultText.trim()) throw new Error('运行结束但未返回有效答复');
      if (task.kind === 'question-decision') {
        this.completeDecision(run, task, result, inferenceDurationMs, summaryUsage()); return;
      }
      s.transaction(() => {
        const current = s.get<Task>('tasks', task.id)!;
        const children = s.byField<Task>('tasks', 'parentId', task.id);
        const reported = s.metadata<{ taskId: string; updatedAt?: string }[]>(`results:${task.id}`) ?? [];
        const waiting = children.some(child => !terminal(child.status)
          || !reported.some(result => result.taskId === child.id && result.updatedAt === child.updatedAt));
        const unknown = children.some(child => child.reconciliationRequired)
          || current.runIds.some(source => s.byField<{ status: string }>('tool_operations', 'runId', source)
            .some(operation => operation.status === 'unknown'));
        s.put('runs', { ...s.get<Run>('runs', run.id) ?? run, status: 'completed', endedAt: now(), usage: addUsage(result.usage, summaryUsage()),
          inferenceDurationMs, inferenceUsage: result.usage, modelDurationMs: result.modelDurationMs ?? s.get<Run>('runs', run.id)?.modelDurationMs });
        const published = background ? draft : completeRunMessage(s, draft, writer.finalText(result.text), current.artifactIds);
        const lastDeliveredSequence = background ? 0 : this.inputs.complete(run.id, inputCutoff);
        const pendingInput = !background && this.inputs.hasPending(task.id);
        this.tasks.update(current, { status: unknown ? 'interrupted' : pendingInput ? 'queued' : waiting ? 'waiting_children' : 'completed',
          reconciliationRequired: unknown, result: resultText, error: unknown ? '存在结果未知的操作，请核查后确认。' : undefined });
        s.put('session_bindings', { ...s.get<SessionBinding>('session_bindings', binding.id) ?? binding,
          nativeSessionId: result.nativeSessionId ?? s.get<SessionBinding>('session_bindings', binding.id)?.nativeSessionId,
          lastDeliveredSequence, memoryVersions: prepared.memoryVersions });
        if (!background) {
          if (result.messages) this.saveHistory(binding, input, result.messages, published, inputCutoff, result.text, result.contextMessages);
          else {
            s.put('provider_archive', { id: run.id, bindingId: binding.id, entries: [], output: result.text });
            clearProgressDeltas(s, run.id);
          }
        }
      });
    } catch (error) {
      try { writer.close(); } catch (writeError) { error = writeError; }
      const hadActiveProcess = this.tools.processes.hasActiveRun(run.id);
      this.nativeContexts.delete(token); await this.tools.settle(run.id);
      await this.tools.processes.settleRun(run.id);
      const duration = inferenceStarted === undefined ? undefined : Date.now() - inferenceStarted;
      if (this.tools.questions.forRun(run.id)) {
        this.waitForInput(run, task, binding, draft, inputCutoff, undefined, { text: '', usage: { source: 'unknown' } }, duration, summaryUsage()); return;
      }
      if (error instanceof ModelRecoveryPendingError && !signal.aborted && !hadActiveProcess
        && s.get<{ checkpoint?: ManagedCheckpoint }>('provider_archive', run.id)?.checkpoint
        && ![...task.runIds, run.id].some(source => s.byField<{ status: string }>('tool_operations', 'runId', source)
          .some(operation => ['unknown', 'dispatched'].includes(operation.status)))) {
        s.transaction(() => {
          s.put('runs', { ...s.get<Run>('runs', run.id)!, status: 'interrupted', endedAt: now(),
            error: error.message, inferenceDurationMs: duration, usage: addUsage(summaryUsage(), { source: 'unknown' }) });
          this.tasks.update(task, { status: 'recovering', recovery: error.recovery, resumeFromRunId: run.id, error: undefined });
        });
        return;
      }
      this.failRun(run, task, draft, error, callerSignal, summaryUsage(), duration);
      if (task.kind === 'question-decision' && !signal.aborted) this.questionDecisionFailed(task, publicError(error));
    } finally {
      await this.tools.processes.settleRun(run.id);
      this.inputs.release(run.id);
      this.tools.releaseRun(run.id); this.nativeContexts.delete(token); this.state.changed();
    }
  }

  private completeDecision(run: Run, task: Task, result: ProviderResult, duration: number, summary?: Usage) {
    const s = this.state.storage;
    s.transaction(() => {
      const answered = this.tools.questions.answerFromChief(task, result.text);
      s.put('runs', { ...s.get<Run>('runs', run.id) ?? run, status: answered ? 'completed' : 'cancelled', endedAt: now(),
        usage: addUsage(result.usage, summary), inferenceUsage: result.usage, inferenceDurationMs: duration,
        modelDurationMs: result.modelDurationMs ?? s.get<Run>('runs', run.id)?.modelDurationMs });
      this.tasks.update(task, { status: answered ? 'completed' : 'cancelled', result: result.text,
        error: answered ? undefined : '问题已处理或主管代答已停止' });
      s.put('provider_archive', { id: run.id, bindingId: run.bindingId, entries: [], messages: result.messages, output: result.text });
      clearProgressDeltas(s, run.id);
    });
  }

  private failRun(run: Run, task: Task, draft: Message, error: unknown, signal: AbortSignal, usage?: Usage, duration?: number) {
    const s = this.state.storage, status = signal.aborted ? 'cancelled' : 'failed';
    s.transaction(() => {
      s.put('runs', { ...s.get<Run>('runs', run.id) ?? run, status, error: publicError(error), endedAt: now(),
        usage: duration === undefined ? usage : addUsage(usage, { source: 'unknown' }), inferenceDurationMs: duration });
      const current = s.get<Task>('tasks', task.id)!;
      const children = s.byField<Task>('tasks', 'parentId', task.id);
      const unknown = current.runIds.some(source => s.byField<{ status: string }>('tool_operations', 'runId', source)
        .some(operation => operation.status === 'unknown'));
      this.tasks.update(current, { status: !signal.aborted && children.some(child => !terminal(child.status)) ? 'waiting_children' : status,
        error: publicError(error), reconciliationRequired: unknown });
      if (!task.kind) interruptRunMessage(s, draft.id);
    });
  }

  private waitForInput(run: Run, task: Task, binding: SessionBinding, draft: Message, cutoff: number, input: RunContext | undefined, result: ProviderResult, duration?: number, summary?: Usage) {
    const s = this.state.storage, question = this.tools.questions.forRun(run.id);
    if (!question) throw new Error('等待用户状态缺少问题记录');
    s.transaction(() => {
      s.put('runs', { ...s.get<Run>('runs', run.id) ?? run, status: 'waiting_input', endedAt: now(), usage: addUsage(result.usage, summary),
        inferenceUsage: result.usage, inferenceDurationMs: duration, modelDurationMs: result.modelDurationMs ?? s.get<Run>('runs', run.id)?.modelDurationMs });
      if (result.text.trim()) completeRunMessage(s, draft, result.text, []); else interruptRunMessage(s, draft.id);
      this.tasks.update(task, { status: question.status === 'answered' ? 'queued' : 'waiting_input', error: undefined });
      if (result.messages && input) this.saveHistory(binding, input, result.messages, draft, cutoff, result.text, result.contextMessages);
      else {
        s.put('provider_archive', { id: run.id, bindingId: binding.id, entries: [], output: result.text,
          toolOperations: s.byField('tool_operations', 'runId', run.id) });
        clearProgressDeltas(s, run.id);
      }
      const current = s.get<SessionBinding>('session_bindings', binding.id) ?? binding;
      const renew = !result.messages;
      const delivered = renew ? 0 : this.inputs.complete(run.id, cutoff);
      if (renew) s.db.prepare('DELETE FROM metadata WHERE key IN (?, ?)')
        .run(`history:${binding.id}`, `history-validity:${binding.id}`);
      s.put('session_bindings', { ...current, lastDeliveredSequence: delivered,
        ...(renew ? { generation: current.generation + 1, nativeSessionId: undefined, memoryVersions: undefined } : {}) });
    });
  }

  private async prepare(run: Run, task: Task, bot: Bot, room: Conversation, connection: Connection,
    binding: SessionBinding, adapter: ProviderAdapter, toolContext: ToolExecutionContext, draft: Message,
    token: string, signal: AbortSignal, writer: RunReplyWriter, saved?: ManagedCheckpoint) {
    const s = this.state.storage;
    const manualCompaction = task.kind === 'context-compaction';
    const archive = task.kind && !manualCompaction ? [] : s.messages(room.id).filter(message => message.status === 'committed'
      && (manualCompaction || (saved ? message.sequence <= saved.cutoff : message.sequence < draft.sequence)));
    // Match the next conversation request without granting tools to the summary request.
    const catalogContext = manualCompaction
      ? this.tools.context(run, { ...task, kind: undefined }, bot, room, toolContext.workspace, signal) : toolContext;
    await this.tools.prepare(catalogContext, bot);
    const managed = connection.provider === 'chatgpt' || connection.provider === 'custom';
    const hasHistory = s.metadata<ModelHistoryEntry[]>(`history:${binding.id}`) !== undefined;
    const delivered = manualCompaction ? archive.at(-1)?.sequence ?? 0
      : managed && !hasHistory ? archive.at(-2)?.sequence ?? 0 : binding.lastDeliveredSequence;
    const delta = manualCompaction ? [] : archive.filter(message => message.sequence > delivered
      && !(message.authorBotId === bot.id && message.runId && s.get<Run>('runs', message.runId)?.bindingId === binding.id));
    const memoryUpdate = managed || task.kind ? undefined : sessionMemory(this.memory, bot, binding, memorySelectOptions(this.state, task, bot, room, delta));
    const { instructions, prompt, contextInstructions, runtimeContext } = runPrompt(this.state, this.memory, task, bot, room, toolContext, delta, memoryUpdate?.prompt, managed);
    const root = dirname(fileURLToPath(import.meta.url));
    const compiled = root.includes(`${join('dist', 'src', 'core')}`);
    const nativeMcp = { command: process.execPath, args: compiled ? [join(root, 'mcp-worker.js')]
      : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href, join(root, 'mcp-worker.ts')],
      env: { AI_TEAM_CORE_URL: this.coreUrl, AI_TEAM_RUN_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' } };
    const input: RunContext = { runId: run.id, bot, connection, binding, workspacePath: toolContext.workspace.path,
      images: [...new Set([...(task.inputArtifactIds ?? []), ...delta.filter(message => message.authorBotId !== bot.id).flatMap(message => message.artifactIds)])]
        .flatMap(artifactId => { const image = modelImage(toolContext.findArtifact(artifactId)); return image ? [image] : []; }),
      resolveImage: imageResolver(this.state, toolContext),
      isWaitingForInput: () => !!this.tools.questions.forRun(run.id), inputSignal: this.tools.inputSignal(run.id),
      prompt: manualCompaction ? '' : prompt, messages: [], instructions, contextInstructions, runtimeContext, tools: this.tools.definitions(catalogContext, bot)
        .sort((a, b) => managed ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : 0), signal,
      nativeMcp,
      parallelToolNames: ['read_file', 'list_directory', 'find_files', 'search_text', 'read_skill', 'read_messages', 'search_messages', 'read_artifact', 'fetch_web', 'search_web'],
      ...(!task.kind ? { userInput: this.inputs.forRun(run, toolContext, draft, saved?.cutoff ?? draft.sequence - 1) } : {}),
      ...(!task.kind && connection.provider === 'qoder' ? { nativeTools: this.tools.nativeTools(toolContext, bot) } : {}),
      emit: event => {
        writer.check();
        const recorded = { id: id(), runId: run.id, ...event, createdAt: now() };
        if (!task.kind && event.type === 'text') writer.append(recorded);
        else { writer.flush(); recordRunEvent(s, recorded); }
        this.state.changed('content');
      },
      executeTool: (name, args, callId) => { writer.flush(); return this.tools.execute(name, args, callId, toolContext, bot); },
      getSecret: ref => this.vault.get(ref), saveSecret: (ref, value) => this.vault.set(ref, value),
      persistBinding: nativeSessionId => { binding.nativeSessionId = nativeSessionId; s.put('session_bindings', binding); },
    };
    if (input.userInput) {
      const beginReply = input.userInput.beginReply;
      input.userInput.beginReply = output => { writer.flush(); beginReply(writer.finalText(output ?? '')); writer.beginReply(); };
    }
    if (managed && !task.kind) {
      input.progress = saved?.progress;
      input.deferRecovery = true;
      input.saveProgress = async (progress, change) => {
        writer.flush();
        const began = performance.now();
        saveManagedProgress(s, run, task, binding, draft, saved?.cutoff ?? draft.sequence - 1, input, progress, change, writer.prefixLength);
        input.emit({ type: 'status', data: { phase: 'performance', stage: 'checkpoint-save',
          mode: change?.type ?? 'snapshot', durationMs: performance.now() - began, messageCount: progress.messages.length } });
      };
    }
    const context = managed ? await prepareManagedContext(input, archive, delivered, this.state, this.contextManager, adapter, manualCompaction) : undefined;
    return { input, summaryUsage: context?.usage ?? (() => undefined), compaction: context?.compaction, memoryVersions: memoryUpdate?.versions };
  }

  private saveHistory(binding: SessionBinding, input: RunContext, messages: RunContext['messages'], draft: Message, cutoff: number, output: string, projected?: RunContext['messages']) {
    const s = this.state.storage;
    const history = workingHistory(this.state, input, messages, draft, cutoff);
    s.put('provider_archive', { id: input.runId, bindingId: binding.id, entries: history.slice(input.messages.length), output });
    clearProgressDeltas(s, input.runId);
    const active = projected ? projectedHistory(history, projected) : history;
    s.setMetadata(`history:${binding.id}`, active);
    saveHistoryValidity(this.state, input);
  }
}
