import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isChiefJob } from './chief-jobs.js';
import type {
  Bot,
  Connection,
  Conversation,
  Message,
  Run,
  SessionBinding,
  Task,
} from '../domain/types.js';
import type { ProviderAdapter, RunContext } from '../domain/provider.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { ContextManager } from '../runtime/context.js';
import type { MemoryService } from '../runtime/memory.js';
import type { Vault } from '../security/vault.js';
import { State, id, now } from './state.js';
import type { ToolRuntime } from './tool-runtime.js';
import { prepareManagedContext } from './managed-context.js';
import { ManagedHistory } from './managed-history.js';
import { memorySelectOptions, runPrompt } from './run-prompt.js';
import { sessionMemory } from './session-memory.js';
import { recordRunEvent } from './run-metrics.js';
import { modelImage, imageResolver } from './run-images.js';
import type { TaskInputService } from './task-inputs.js';
import { saveManagedProgress, type ManagedCheckpoint } from './managed-progress.js';
import type { RunReplyWriter } from './run-reply.js';
import { runReasoningEffort } from './run-reasoning.js';

export interface RunPreparationInput {
  run: Run;
  task: Task;
  bot: Bot;
  room: Conversation;
  connection: Connection;
  binding: SessionBinding;
  adapter: ProviderAdapter;
  toolContext: ToolExecutionContext;
  token: string;
  signal: AbortSignal;
  writer: RunReplyWriter;
  saved?: ManagedCheckpoint;
  coreUrl: string;
}

export class RunPreparation {
  constructor(
    private state: State,
    private tools: ToolRuntime,
    private memory: MemoryService,
    private contextManager: ContextManager,
    private vault: Vault,
    private inputs: TaskInputService,
  ) {}

  async prepare(scope: RunPreparationInput) {
    const { run, task, bot, room, connection, adapter, toolContext, signal, writer, saved } = scope;
    const draft = writer.current;
    const cutoff = saved?.cutoff ?? draft.sequence - 1;
    const s = this.state.storage;
    const manualCompaction = task.kind === 'context-compaction';
    const archive =
      task.kind && !manualCompaction
        ? []
        : s
            .messages(room.id)
            .filter(
              (message) =>
                message.status === 'committed' && (manualCompaction || message.sequence <= cutoff),
            );
    // Checkpoint compatibility uses the conversation catalog and its initialized connection services.
    const catalogContext = manualCompaction
      ? {
          ...this.tools.context(
            run,
            { ...task, kind: undefined },
            bot,
            room,
            toolContext.workspace,
            signal,
          ),
          getSecret: toolContext.getSecret,
        }
      : toolContext;
    if (!isChiefJob(task)) await this.tools.prepare(catalogContext, bot);
    const managed = connection.provider === 'chatgpt' || connection.provider === 'custom';
    const { delivered, delta, memoryUpdate } = this.selectHistory(
      scope,
      archive,
      managed,
      manualCompaction,
    );
    const { instructions, prompt, contextInstructions, runtimeContext } = runPrompt(
      this.state,
      this.memory,
      task,
      bot,
      room,
      toolContext,
      delta,
      memoryUpdate?.prompt,
      managed,
    );
    const input = this.createInput(
      scope,
      catalogContext,
      { delta, cutoff, managed, manualCompaction },
      { instructions, prompt, contextInstructions, runtimeContext },
    );
    if (managed && !task.kind) this.attachCheckpoint(scope, input, cutoff);
    const context =
      managed && !isChiefJob(task)
        ? await prepareManagedContext(
            input,
            archive,
            delivered,
            this.state,
            this.contextManager,
            adapter,
            manualCompaction,
          )
        : undefined;
    return {
      input,
      summaryUsage: context?.usage ?? (() => undefined),
      compaction: context?.compaction,
      memoryVersions: memoryUpdate?.versions,
    };
  }
  private createInput(
    scope: RunPreparationInput,
    catalogContext: ToolExecutionContext,
    history: { delta: Message[]; cutoff: number; managed: boolean; manualCompaction: boolean },
    prompts: ReturnType<typeof runPrompt>,
  ): RunContext {
    const { run, task, bot, connection, binding, toolContext, token, signal, writer, coreUrl } =
      scope;
    const { delta, cutoff, managed, manualCompaction } = history;
    const { instructions, prompt, contextInstructions, runtimeContext } = prompts;
    const s = this.state.storage;
    const root = dirname(fileURLToPath(import.meta.url));
    const compiled = root.includes(`${join('dist', 'src', 'core')}`);
    const nativeMcp = {
      command: process.execPath,
      args: compiled
        ? [join(root, 'mcp-worker.js')]
        : [
            '--import',
            pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
            join(root, 'mcp-worker.ts'),
          ],
      env: { AI_TEAM_CORE_URL: coreUrl, AI_TEAM_RUN_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
    };
    const input: RunContext = {
      runId: run.id,
      bot,
      connection,
      binding,
      workspacePath: toolContext.workspace.path,
      images: [
        ...new Set([
          ...(task.inputArtifactIds ?? []),
          ...delta
            .filter((message) => message.authorBotId !== bot.id)
            .flatMap((message) => message.artifactIds),
        ]),
      ].flatMap((artifactId) => {
        const image = modelImage(toolContext.findArtifact(artifactId));
        return image ? [image] : [];
      }),
      resolveImage: imageResolver(this.state, toolContext),
      isWaitingForInput: () => this.tools.waiting(run.id),
      inputSignal: this.tools.inputSignal(run.id),
      prompt: manualCompaction ? '' : prompt,
      messages: [],
      instructions,
      contextInstructions,
      runtimeContext,
      ...(managed && !task.kind
        ? { getReasoningEffort: () => runReasoningEffort(this.state, bot, scope.room, connection) }
        : {}),
      tools: (isChiefJob(task) ? [] : this.tools.definitions(catalogContext, bot)).sort((a, b) => {
        if (!managed || a.name === b.name) return 0;
        if (a.name < b.name) return -1;
        return 1;
      }),
      signal,
      nativeMcp,
      parallelToolNames: [
        'read_file',
        'list_directory',
        'find_files',
        'search_text',
        'read_skill',
        'read_messages',
        'search_messages',
        'read_artifact',
        'fetch_web',
        'search_web',
      ],
      ...(!task.kind
        ? {
            userInput: this.inputs.forRun(run, toolContext, cutoff, (output) =>
              writer.beginReply(output),
            ),
          }
        : {}),
      ...(!task.kind && connection.provider === 'qoder'
        ? { nativeTools: this.tools.nativeTools(toolContext, bot) }
        : {}),
      emit: (event) => {
        writer.check();
        const recorded = { id: id(), runId: run.id, ...event, createdAt: now() };
        if (!task.kind && event.type === 'text') writer.append(recorded);
        else {
          writer.flush();
          recordRunEvent(s, recorded);
        }
        this.state.changed('content');
      },
      executeTool: (name, args, callId) => {
        if (isChiefJob(task)) throw new Error('上下文后台请求不执行工具');
        writer.flush();
        return this.tools.execute(name, args, callId, toolContext, bot);
      },
      getSecret: (ref) => this.vault.get(ref),
      saveSecret: (ref, value) => this.vault.set(ref, value),
      persistBinding: (nativeSessionId) => {
        binding.nativeSessionId = nativeSessionId;
        s.put('session_bindings', binding);
      },
    };
    return input;
  }

  private attachCheckpoint(scope: RunPreparationInput, input: RunContext, cutoff: number) {
    const { run, task, binding, writer, saved } = scope;
    const s = this.state.storage;
    input.progress = saved?.progress;
    input.deferRecovery = true;
    input.saveProgress = async (progress, change) => {
      writer.flush();
      const began = performance.now();
      saveManagedProgress(
        s,
        run,
        task,
        binding,
        writer.current,
        cutoff,
        input,
        progress,
        change,
        writer.prefixLength,
      );
      input.emit({
        type: 'status',
        data: {
          phase: 'performance',
          stage: 'checkpoint-save',
          mode: change?.type ?? 'snapshot',
          durationMs: performance.now() - began,
          messageCount: progress.messages.length,
        },
      });
    };
  }

  private selectHistory(
    scope: RunPreparationInput,
    archive: Message[],
    managed: boolean,
    manualCompaction: boolean,
  ) {
    const { task, bot, binding, room } = scope;
    const s = this.state.storage;
    const hasHistory = new ManagedHistory(this.state).has(binding.id);
    let delivered = binding.lastDeliveredSequence;
    if (manualCompaction) delivered = archive.at(-1)?.sequence ?? 0;
    else if (managed && !hasHistory) delivered = archive.at(-2)?.sequence ?? 0;
    const delta = manualCompaction
      ? []
      : archive.filter(
          (message) =>
            message.sequence > delivered &&
            !(
              message.authorBotId === bot.id &&
              message.runId &&
              s.get<Run>('runs', message.runId)?.bindingId === binding.id
            ),
        );
    const memoryUpdate =
      managed || task.kind
        ? undefined
        : sessionMemory(
            this.memory,
            bot,
            binding,
            memorySelectOptions(this.state, task, bot, room, delta),
          );
    return { delivered, delta, memoryUpdate };
  }
}
