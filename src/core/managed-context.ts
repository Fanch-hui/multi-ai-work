import type { ModelMessage, ProviderAdapter, RunContext } from '../domain/provider.js';
import type { ContextCheckpoint, Message, Usage, Run, Task, Conversation } from '../domain/types.js';
import { ContextManager, contextSourceHash, contextCompatibilityHash } from '../runtime/context.js';
import { modelMessageHistory, type ModelHistoryEntry } from '../runtime/model-history.js';
import { State, id } from './state.js';
import { addUsage } from '../domain/usage.js';
import { modelImage } from './run-images.js';
import { defaultContextWindow, managedContextBudget } from '../domain/context-settings.js';
import { runMessageSources } from './run-message.js';
import { compactRunMessages } from '../runtime/run-compaction.js';
import { estimateTokens, estimateModelMessagesTokens } from '../runtime/model-history.js';
import { ContextReferences } from './context-references.js';

export { addUsage } from '../domain/usage.js';

export interface ProviderArchive { id: string; bindingId: string; entries: ModelHistoryEntry[]; output?: string; }

export async function prepareManagedContext(input: RunContext, archive: Message[], delivered: number,
  state: State, manager: ContextManager, adapter: ProviderAdapter): Promise<() => Usage | undefined> {
  const s = state.storage;
  const savedHistory = s.metadata<ModelHistoryEntry[]>(`history:${input.binding.id}`);
  const history = savedHistory
    ?? modelMessageHistory(archive.filter(message => message.sequence <= delivered), input.bot.id, artifactId => modelImage(s.get('artifacts', artifactId)));
  const loadArchiveHistory = () => {
    const entries = s.byField<ProviderArchive>('provider_archive', 'bindingId', input.binding.id).flatMap(record => record.entries);
    return entries.length ? entries : undefined;
  };
  const window = input.bot.contextWindow ?? defaultContextWindow(input.connection.provider,
    input.connection.models.find(model => model.id === input.bot.model));
  const settings = managedContextBudget(window, input.bot.compactionThreshold, input.bot.outputReserve);
  const { availableTokens: budget, triggerTokens } = settings;
  const run = s.get<Run>('runs', input.runId);
  const task = run && s.get<Task>('tasks', run.taskId), room = s.get<Conversation>('conversations', input.binding.conversationId);
  const references = task && room ? new ContextReferences(state, { runId: input.runId, task, room, bot: input.bot,
    toolNames: input.tools.map(tool => tool.name), signal: input.signal, inlineToolLimit: budget ? Math.min(32000, Math.floor(budget * 0.5)) : 32000 }) : undefined;
  const preserveReferences = references?.preserveReferences.bind(references);
  const { summarize, usage } = summaryRunner(input, adapter);
  const signature = contextCompatibilityHash({ ...input, protocol: input.connection.protocol });
  input.contextSignature = signature;
  const validity = s.metadata<HistoryValidity>(`history-validity:${input.binding.id}`);
  const sourceIds = new Set(validity?.sourceIds);
  const sources = validity && archive.filter(message => sourceIds.has(message.id));
  const historyIsCurrent = !!(savedHistory && validity && validity.generation === input.binding.generation && validity.signature === signature
    && sources?.length === validity.sourceIds.length && contextSourceHash(sources) === validity.sourceHash);
  const prepare = (force: boolean, currentInput: string) => manager.prepare({ binding: input.binding,
    messages: archive, instructions: input.instructions, contextInstructions: input.contextInstructions,
    protocol: input.connection.protocol, tools: input.tools, history, historyIsCurrent,
    loadArchiveHistory, currentInput, preserveReferences,
    contextWindow: budget, triggerTokens, force, signal: input.signal, summarize,
    isSourceCurrent: (ids, hash) => {
      const expected = new Set(ids);
      return contextSourceHash(s.messages(input.binding.conversationId).filter(message => expected.has(message.id))) === hash;
    } });
  const prepared = await prepare(false, input.prompt);
  const progress = input.progress;
  const raw = progress?.compaction ? [...progress.compaction.archived, ...progress.messages.slice(progress.compaction.start)] : progress?.messages;
  if (progress && progress.contextSignature !== signature) {
    const current = raw!.slice(progress.archiveStart ?? progress.currentStart);
    progress.messages = [...prepared.messages, ...current];
    progress.currentStart = prepared.messages.length;
    progress.archiveStart = prepared.messages.length;
    progress.compaction = undefined;
    progress.contextSignature = signature;
    input.messages = prepared.messages;
  } else input.messages = progress ? raw!.slice(0, progress.archiveStart ?? progress.currentStart) : prepared.messages;
  input.emit({ type: 'context', data: { estimatedTokens: prepared.estimatedTokens, ...settings, source: 'app-estimated', owner: 'app' } });
  input.compactContext = async (messages, options) => {
    if (!budget || !triggerTokens) return undefined;
    const originalTokens = estimateTokens(input.instructions) + estimateTokens(input.tools) + 256
      + estimateModelMessagesTokens(messages, input.connection.protocol);
    let next;
    try { next = await compactRunMessages(messages, { ...options, budget, trigger: triggerTokens,
      fixedTokens: estimateTokens(input.instructions) + estimateTokens(input.tools) + 256,
      protocol: input.connection.protocol ?? 'responses', signal: input.signal, summarize, preserveReferences,
      preserveToolOutput: references ? async message => {
        const reference = await references.preserveToolOutput(message);
        return reference ? references.preserveReferences([message], [reference.id]) : undefined;
      } : undefined });
    } catch {
      input.signal.throwIfAborted();
      input.emit({ type: 'compaction', data: { status: 'failed', reason: 'summary_failed', scope: 'run' } });
      if (originalTokens > budget && !options.force) throw new Error('模型上下文超过输入预算，摘要未能完成，需要分割资料');
      return undefined;
    }
    if (!next && originalTokens > budget && !options.force) throw new Error('模型上下文超过输入预算，无法继续缩小，需要分割资料');
    if (next) input.emit({ type: 'context', data: { estimatedTokens: estimateTokens(input.instructions) + estimateTokens(input.tools)
      + 256 + estimateModelMessagesTokens(next.messages, input.connection.protocol), ...settings, source: 'app-estimated', owner: 'app', recovery: options.force } });
    return next;
  };
  return usage;
}

function summaryRunner(input: RunContext, adapter: ProviderAdapter) {
  let summaryUsage: Usage | undefined;
  const summarize = async (prompt: string, signal: AbortSignal) => {
    const runId = `${input.runId}:summary:${id()}`;
    const summary = await adapter.run({ ...input, runId, prompt, messages: [], images: [], tools: [],
      instructions: '将提供的历史整理为摘要，只输出摘要，不执行操作。', signal, recoverContext: undefined, compactContext: undefined,
      userInput: undefined, progress: undefined, saveProgress: undefined, deferRecovery: false,
      emit: event => {
        if (event.type === 'usage') input.emit({ ...event, data: { ...event.data, phase: 'compaction' } });
        if (event.type === 'status' && String(event.data.phase).startsWith('model-')) input.emit({ ...event,
          data: { ...event.data, scope: 'compaction',
            requestId: event.data.requestId ?? `${runId}:${event.data.step}` } });
      },
      executeTool: async () => { throw new Error('摘要任务不执行工具'); } });
    summaryUsage = addUsage(summaryUsage, summary.usage ?? { source: 'unknown' });
    return summary.text;
  };
  return { summarize, usage: () => summaryUsage };
}

export function workingHistory(state: State, input: RunContext, messages: ModelMessage[], draft: Message, cutoff: number): ModelHistoryEntry[] {
  const s = state.storage;
  const conversation = s.messages(draft.conversationId);
  const previous = s.metadata<ModelHistoryEntry[]>(`history:${input.binding.id}`)
    ?? modelMessageHistory(conversation.filter(message => message.sequence <= cutoff), input.bot.id, artifactId => modelImage(s.get('artifacts', artifactId)));
  const source = conversation.filter(message => message.sequence <= cutoff).at(-1) ?? draft;
  const checkpoint = s.byField<ContextCheckpoint>('context_checkpoints', 'bindingId', input.binding.id).at(-1);
  const matchHistory = historyMatcher(previous);
  let currentSource = source;
  const sources = runMessageSources(s, input.runId);
  const replies = conversation.filter(message => message.runId && sources.has(message.runId) && message.authorBotId === input.bot.id);
  const userSequences = messages.flatMap(message => message.sourceSequence !== undefined ? [message.sourceSequence] : []);
  return messages.map((message, index) => {
    if (index < input.messages.length || message.contextSummary) {
      if (checkpoint && message.content === `此前对话摘要（历史资料）：\n${checkpoint.content}`)
        return { messageId: checkpoint.sourceMessageIds.at(-1) ?? source.id, sequence: checkpoint.throughSequence, message };
      const match = matchHistory(message);
      if (match >= 0) return previous[match];
      return { messageId: source.id, sequence: source.sequence, message };
    }
    if (message.sourceMessageId && message.sourceSequence !== undefined) {
      currentSource = s.getMessage(message.sourceMessageId) ?? currentSource;
      return { messageId: message.sourceMessageId, sequence: message.sourceSequence, message };
    }
    if (index === input.messages.length) return { messageId: source.id, sequence: source.sequence, message };
    const nextUser = userSequences.find(sequence => sequence > currentSource.sequence) ?? Infinity;
    const reply = replies.find(item => item.sequence > currentSource.sequence && item.sequence < nextUser) ?? currentSource;
    return { messageId: reply.id, sequence: reply.sequence, message };
  });
}

export function projectedHistory(history: ModelHistoryEntry[], messages: ModelMessage[]): ModelHistoryEntry[] {
  const matchHistory = historyMatcher(history);
  const matches = messages.map(matchHistory);
  let next = history.length;
  const result: ModelHistoryEntry[] = new Array(messages.length);
  for (let index = messages.length - 1; index >= 0; index--) {
    const match = matches[index];
    const source = history[match >= 0 ? match : Math.max(0, next - 1)];
    result[index] = { ...source, message: messages[index] };
    if (match >= 0) next = match;
  }
  return result;
}

function historyMatcher(history: ModelHistoryEntry[]) {
  const positions = new Map<string, { indices: number[]; offset: number }>();
  history.forEach((entry, index) => {
    const key = JSON.stringify(entry.message), value = positions.get(key) ?? { indices: [], offset: 0 };
    value.indices.push(index); positions.set(key, value);
  });
  let cursor = 0;
  return (message: ModelMessage) => {
    const value = positions.get(JSON.stringify(message));
    if (!value) return -1;
    while (value.offset < value.indices.length && value.indices[value.offset] < cursor) value.offset++;
    const match = value.indices[value.offset++] ?? -1;
    if (match >= 0) cursor = match + 1;
    return match;
  };
}

interface HistoryValidity { generation: number; signature: string; sourceIds: string[]; sourceHash: string; }
export function saveHistoryValidity(state: State, input: RunContext) {
  const sources = state.storage.messages(input.binding.conversationId).filter(message => message.status === 'committed');
  state.storage.setMetadata(`history-validity:${input.binding.id}`, {
    generation: input.binding.generation, signature: contextCompatibilityHash({ ...input, protocol: input.connection.protocol }),
    sourceIds: sources.map(message => message.id), sourceHash: contextSourceHash(sources),
  } satisfies HistoryValidity);
}
