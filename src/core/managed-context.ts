import type { ModelMessage, ProviderAdapter, RunContext } from '../domain/provider.js';
import type { ContextCheckpoint, Message, Usage } from '../domain/types.js';
import { ContextManager, contextSourceHash } from '../runtime/context.js';
import { modelMessageHistory, type ModelHistoryEntry } from '../runtime/model-history.js';
import { State, id } from './state.js';
import { addUsage } from '../domain/usage.js';
import { modelImage } from './run-images.js';
import { defaultContextWindow, managedContextBudget } from '../domain/context-settings.js';
import { runMessageSources } from './run-message.js';

export { addUsage } from '../domain/usage.js';

export interface ProviderArchive { id: string; bindingId: string; entries: ModelHistoryEntry[]; output?: string; }

export async function prepareManagedContext(input: RunContext, archive: Message[], delivered: number,
  state: State, manager: ContextManager, adapter: ProviderAdapter): Promise<() => Usage | undefined> {
  const s = state.storage;
  const history = s.metadata<ModelHistoryEntry[]>(`history:${input.binding.id}`)
    ?? modelMessageHistory(archive.filter(message => message.sequence <= delivered), input.bot.id, artifactId => modelImage(s.get('artifacts', artifactId)));
  const loadArchiveHistory = () => {
    const entries = s.byField<ProviderArchive>('provider_archive', 'bindingId', input.binding.id).flatMap(record => record.entries);
    return entries.length ? entries : undefined;
  };
  const window = input.bot.contextWindow ?? defaultContextWindow(input.connection.provider,
    input.connection.models.find(model => model.id === input.bot.model));
  const settings = managedContextBudget(window, input.bot.compactionThreshold, input.bot.outputReserve);
  const { availableTokens: budget, triggerTokens } = settings;
  let summaryUsage: Usage | undefined;
  const summarize = async (prompt: string, signal: AbortSignal) => {
    const runId = `${input.runId}:summary:${id()}`;
    const summary = await adapter.run({ ...input, runId, prompt, messages: [], images: [], tools: [],
      instructions: '将提供的历史整理为摘要，只输出摘要，不执行操作。', signal, recoverContext: undefined,
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
  const prepare = (force: boolean, currentInput: string) => manager.prepare({ binding: input.binding,
    messages: archive, instructions: input.instructions, tools: input.tools, history,
    loadArchiveHistory, currentInput,
    contextWindow: budget, triggerTokens, force, signal: input.signal, summarize,
    isSourceCurrent: (ids, hash) => contextSourceHash(s.messages(input.binding.conversationId).filter(message => ids.includes(message.id))) === hash });
  const prepared = await prepare(false, input.prompt);
  input.messages = input.progress ? input.progress.messages.slice(0, input.progress.currentStart) : prepared.messages;
  const runStart = input.messages.length;
  input.emit({ type: 'context', data: { estimatedTokens: prepared.estimatedTokens, ...settings, source: 'app-estimated', owner: 'app' } });
  input.recoverContext = async (messages: ModelMessage[]) => {
    if (!budget) return undefined;
    const current = messages.slice(runStart);
    if (current[0]?.role !== 'user') return undefined;
    const next = await prepare(true, JSON.stringify(current));
    input.messages = next.messages;
    input.emit({ type: 'context', data: { estimatedTokens: next.estimatedTokens, ...settings,
      source: 'app-estimated', owner: 'app', recovery: true } });
    return [...next.messages, ...current];
  };
  return () => summaryUsage;
}

export function workingHistory(state: State, input: RunContext, messages: ModelMessage[], draft: Message, cutoff: number): ModelHistoryEntry[] {
  const s = state.storage;
  const previous = s.metadata<ModelHistoryEntry[]>(`history:${input.binding.id}`)
    ?? modelMessageHistory(s.messages(draft.conversationId).filter(message => message.sequence <= cutoff), input.bot.id, artifactId => modelImage(s.get('artifacts', artifactId)));
  const source = s.messages(draft.conversationId).filter(message => message.sequence <= cutoff).at(-1) ?? draft;
  const checkpoint = s.byField<ContextCheckpoint>('context_checkpoints', 'bindingId', input.binding.id).at(-1);
  let cursor = 0;
  let currentSource = source;
  const sources = runMessageSources(s, input.runId);
  const replies = s.messages(draft.conversationId).filter(message => message.runId && sources.has(message.runId) && message.authorBotId === input.bot.id);
  const userSequences = messages.flatMap(message => message.sourceSequence !== undefined ? [message.sourceSequence] : []);
  return messages.map((message, index) => {
    if (index < input.messages.length) {
      if (checkpoint && message.content === `此前对话摘要（历史资料）：\n${checkpoint.content}`)
        return { messageId: checkpoint.sourceMessageIds.at(-1) ?? source.id, sequence: checkpoint.throughSequence, message };
      const match = previous.findIndex((entry, position) => position >= cursor && JSON.stringify(entry.message) === JSON.stringify(message));
      if (match >= 0) { cursor = match + 1; return previous[match]; }
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
