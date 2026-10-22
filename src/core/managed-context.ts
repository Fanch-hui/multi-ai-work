import type { ModelMessage, ProviderAdapter, RunContext } from '../domain/provider.js';
import type { Message, Usage, Run, Task, Conversation } from '../domain/types.js';
import {
  ContextManager,
  contextSourceHash,
  contextCompatibilityHash,
  type PreparedContext,
} from '../runtime/context.js';
import { State, id } from './state.js';
import { addUsage } from '../domain/usage.js';
import { defaultContextWindow, managedContextBudget } from '../domain/context-settings.js';
import { compactRunMessages } from '../runtime/run-compaction.js';
import { estimateTokens, estimateModelMessagesTokens } from '../runtime/model-history.js';
import { ContextReferences } from './context-references.js';
import {
  needsRuntimeContext,
  prepareRuntimeContext,
  retainRuntimeContext,
} from './run-runtime-context.js';
import { prepareToolResultBudget } from './tool-result-budget.js';
import { prepareImageInputBudget } from './image-input-budget.js';

export { addUsage } from '../domain/usage.js';

export {
  workingHistory,
  projectedHistory,
  saveHistoryValidity,
  type ProviderArchive,
} from './managed-history.js';
import { ManagedHistory } from './managed-history.js';

interface ManagedContextPreparation {
  usage(): Usage | undefined;
  compaction?: { outcome: NonNullable<Task['contextCompactionOutcome']>; result: string };
}

export async function prepareManagedContext(
  input: RunContext,
  archive: Message[],
  delivered: number,
  state: State,
  manager: ContextManager,
  adapter: ProviderAdapter,
  force = false,
): Promise<ManagedContextPreparation> {
  const s = state.storage;
  const histories = new ManagedHistory(state);
  const { history, historyIsCurrent, loadArchiveHistory } = histories.load(
    input,
    archive,
    delivered,
  );
  const window =
    input.bot.contextWindow ??
    defaultContextWindow(
      input.connection.provider,
      input.connection.models.find((model) => model.id === input.bot.model),
    );
  const settings = managedContextBudget(
    window,
    input.bot.compactionThreshold,
    input.bot.outputReserve,
  );
  const { availableTokens: budget, triggerTokens } = settings;
  const run = s.get<Run>('runs', input.runId);
  const task = run && s.get<Task>('tasks', run.taskId);
  const room = s.get<Conversation>('conversations', input.binding.conversationId);
  const references =
    task && room
      ? new ContextReferences(state, {
          runId: input.runId,
          task,
          room,
          bot: input.bot,
          toolNames: input.tools.map((tool) => tool.name),
          signal: input.signal,
          inlineToolLimit: budget ? Math.min(32000, Math.floor(budget * 0.5)) : 32000,
        })
      : undefined;
  input.prepareToolResults = prepareToolResultBudget(input, references, budget);
  input.prepareImageInputs = prepareImageInputBudget(input);
  const preserveReferences = references?.preserveReferences.bind(references);
  const { summarize, usage } = summaryRunner(input, adapter);
  const signature = contextCompatibilityHash({ ...input, protocol: input.connection.protocol });
  input.contextSignature = signature;
  const currentRuntime = input.runtimeContext;
  const includeRuntime = needsRuntimeContext(
    history.map((entry) => entry.message),
    currentRuntime,
  );
  const currentInput = input.prompt + (includeRuntime ? `\n${currentRuntime!.content}` : '');
  const prepared = await manager.prepare({
    binding: input.binding,
    messages: archive,
    instructions: input.instructions,
    contextInstructions: input.contextInstructions,
    protocol: input.connection.protocol,
    tools: input.tools,
    history,
    historyIsCurrent,
    loadArchiveHistory,
    currentInput,
    preserveReferences,
    contextWindow: budget,
    triggerTokens,
    force,
    signal: input.signal,
    summarize,
    isSourceCurrent: (ids, hash) => {
      const expected = new Set(ids);
      return (
        contextSourceHash(
          s.messages(input.binding.conversationId).filter((message) => expected.has(message.id)),
        ) === hash
      );
    },
  });
  prepareRuntimeContext(input, prepared.messages, signature);
  input.emit({
    type: 'context',
    data: {
      estimatedTokens: prepared.estimatedTokens,
      ...settings,
      source: 'app-estimated',
      owner: 'app',
    },
  });
  if (force) {
    const compaction = manualCompactionResult(prepared.compaction);
    if (compaction.outcome === 'compressed') {
      s.transaction(() => {
        const source = archive.at(-1)!;
        histories.saveProjection(
          input,
          histories.mapSources(input, input.messages, source, source.sequence),
        );
      });
    }
    return { usage, compaction };
  }
  input.compactContext = runCompactor(input, settings, references, summarize, currentRuntime);
  return { usage };
}

function manualCompactionResult(
  compaction: PreparedContext['compaction'],
): NonNullable<ManagedContextPreparation['compaction']> {
  const { status, reason } = compaction ?? { status: 'unchanged', reason: 'no_history' };
  if (status === 'failed') {
    if (reason === 'summary_failed' || reason === 'needs_split')
      throw new Error('摘要生成未完成，请稍后重试');
    if (reason === 'source_changed') throw new Error('对话内容已变化，请重新压缩');
    if (reason === 'over_budget')
      throw new Error('压缩后仍超过上下文预算，请减少本轮资料或调整上下文设置');
    throw new Error('上下文压缩未完成，请稍后重试');
  }
  if (status === 'unchanged') {
    return {
      outcome: 'unchanged',
      result:
        reason === 'not_smaller'
          ? '本次摘要未减少上下文占用，已保留原上下文'
          : '当前没有可压缩的较早历史，可继续对话后再试',
    };
  }
  return { outcome: 'compressed', result: '上下文已压缩，完整聊天记录已保留' };
}

function runCompactor(
  input: RunContext,
  settings: ReturnType<typeof managedContextBudget>,
  references: ContextReferences | undefined,
  summarize: (prompt: string, signal: AbortSignal) => Promise<string>,
  currentRuntime?: ModelMessage,
) {
  const { availableTokens: budget, triggerTokens } = settings;
  const preserveReferences = references?.preserveReferences.bind(references);
  const compact: NonNullable<RunContext['compactContext']> = async (messages, options) => {
    if (!budget || !triggerTokens) return undefined;
    const originalTokens =
      estimateTokens(input.instructions) +
      estimateTokens(input.tools) +
      256 +
      estimateModelMessagesTokens(messages, input.connection.protocol);
    let next;
    try {
      next = await compactRunMessages(messages, {
        ...options,
        budget,
        trigger: triggerTokens,
        fixedTokens: estimateTokens(input.instructions) + estimateTokens(input.tools) + 256,
        protocol: input.connection.protocol ?? 'responses',
        signal: input.signal,
        summarize,
        preserveReferences,
        preserveToolOutput: references
          ? async (message) => {
              const reference = await references.preserveToolOutput(message);
              if (!reference) return undefined;
              message.contextArtifactIds = [
                ...new Set([reference.id, ...(message.contextArtifactIds ?? [])]),
              ];
              const preserved = await references.preserveReferences([message], [reference.id]);
              if (!preserved.artifactIds.includes(reference.id)) return undefined;
              return {
                ...preserved,
                artifactIds: [...new Set([reference.id, ...preserved.artifactIds])],
              };
            }
          : undefined,
      });
    } catch {
      input.signal.throwIfAborted();
      input.emit({
        type: 'compaction',
        data: { status: 'failed', reason: 'summary_failed', scope: 'run' },
      });
      if (originalTokens > budget && !options.force)
        throw new Error('模型上下文超过输入预算，摘要未能完成，需要分割资料');
      return undefined;
    }
    if (next) {
      next = retainRuntimeContext(next.messages, next.currentStart, currentRuntime);
      if (
        estimateTokens(input.instructions) +
          estimateTokens(input.tools) +
          256 +
          estimateModelMessagesTokens(next.messages, input.connection.protocol) >
        triggerTokens
      )
        next = undefined;
    }
    if (!next && originalTokens > budget && !options.force)
      throw new Error('模型上下文超过输入预算，无法继续缩小，需要分割资料');
    if (next)
      input.emit({
        type: 'context',
        data: {
          estimatedTokens:
            estimateTokens(input.instructions) +
            estimateTokens(input.tools) +
            256 +
            estimateModelMessagesTokens(next.messages, input.connection.protocol),
          ...settings,
          source: 'app-estimated',
          owner: 'app',
          recovery: options.force,
        },
      });
    return next;
  };
  return compact;
}

function summaryRunner(input: RunContext, adapter: ProviderAdapter) {
  let summaryUsage: Usage | undefined;
  const summarize = async (prompt: string, signal: AbortSignal) => {
    const runId = `${input.runId}:summary:${id()}`;
    const summary = await adapter.run({
      ...input,
      runId,
      prompt,
      messages: [],
      images: [],
      tools: [],
      instructions: '将提供的历史整理为摘要，只输出摘要，不执行操作。',
      signal,
      compactContext: undefined,
      userInput: undefined,
      progress: undefined,
      saveProgress: undefined,
      runtimeContext: undefined,
      getReasoningEffort: undefined,
      prepareToolResults: undefined,
      prepareImageInputs: undefined,
      deferRecovery: false,
      emit: (event) => {
        if (event.type === 'usage')
          input.emit({ ...event, data: { ...event.data, phase: 'compaction' } });
        if (event.type === 'status' && String(event.data.phase).startsWith('model-'))
          input.emit({
            ...event,
            data: {
              ...event.data,
              scope: 'compaction',
              requestId: event.data.requestId ?? `${runId}:${event.data.step}`,
            },
          });
      },
      executeTool: async () => {
        throw new Error('摘要任务不执行工具');
      },
    });
    summaryUsage = addUsage(summaryUsage, summary.usage ?? { source: 'unknown' });
    return summary.text;
  };
  return { summarize, usage: () => summaryUsage };
}
