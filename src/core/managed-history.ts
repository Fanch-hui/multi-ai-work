import type { ModelMessage, RunContext } from '../domain/provider.js';
import type { ContextCheckpoint, Message } from '../domain/types.js';
import { contextSourceHash, contextCompatibilityHash } from '../runtime/context.js';
import { modelMessageHistory, type ModelHistoryEntry } from '../runtime/model-history.js';
import type { State } from './state.js';
import { modelImage } from './run-images.js';
import { runMessageSources } from './run-message.js';
import { clearProgressDeltas } from './managed-progress-deltas.js';

export interface ProviderArchive {
  id: string;
  bindingId: string;
  entries: ModelHistoryEntry[];
  output?: string;
}

interface HistoryCommit {
  input: RunContext;
  messages: ModelMessage[];
  draft: Message;
  cutoff: number;
  output: string;
  projected?: ModelMessage[];
}

/** Owns durable protocol archives, working projections and their source validity. */
export class ManagedHistory {
  constructor(private state: State) {}

  has(bindingId: string): boolean {
    return this.state.storage.metadata<ModelHistoryEntry[]>(`history:${bindingId}`) !== undefined;
  }

  load(input: RunContext, archive: Message[], delivered: number) {
    const storage = this.state.storage;
    const saved = storage.metadata<ModelHistoryEntry[]>(`history:${input.binding.id}`);
    const validity = storage.metadata<HistoryValidity>(`history-validity:${input.binding.id}`);
    const sourceIds = new Set(validity?.sourceIds);
    const sources = validity && archive.filter((message) => sourceIds.has(message.id));
    const signature = contextCompatibilityHash({ ...input, protocol: input.connection.protocol });
    const historyIsCurrent = !!(
      saved &&
      validity &&
      validity.generation === input.binding.generation &&
      validity.signature === signature &&
      sources?.length === validity.sourceIds.length &&
      contextSourceHash(sources) === validity.sourceHash
    );
    const clean = (entries: ModelHistoryEntry[]) =>
      historyIsCurrent
        ? entries
        : entries.filter((entry) => entry.message.appContext?.source !== 'app.runtime');
    const history = clean(
      saved ??
        modelMessageHistory(
          archive.filter((message) => message.sequence <= delivered),
          input.bot.id,
          (artifactId) => modelImage(storage.get('artifacts', artifactId)),
        ),
    );
    const loadArchiveHistory = () => {
      const entries = storage
        .byField<ProviderArchive>('provider_archive', 'bindingId', input.binding.id)
        .flatMap((record) => record.entries);
      return entries.length ? clean(entries) : undefined;
    };
    return { history, historyIsCurrent, loadArchiveHistory };
  }

  mapSources(input: RunContext, messages: ModelMessage[], draft: Message, cutoff: number) {
    return workingHistory(this.state, input, messages, draft, cutoff);
  }

  /** Call inside the run settlement transaction, after publishing the reply. */
  commit({ input, messages, draft, cutoff, output, projected }: HistoryCommit) {
    const history = this.mapSources(input, messages, draft, cutoff);
    this.state.storage.put('provider_archive', {
      id: input.runId,
      bindingId: input.binding.id,
      entries: history.slice(input.messages.length),
      output,
    });
    clearProgressDeltas(this.state.storage, input.runId);
    const active = projected ? projectedHistory(history, projected) : history;
    this.saveProjection(input, active);
  }

  saveProjection(input: RunContext, history: ModelHistoryEntry[]) {
    this.state.storage.setMetadata(`history:${input.binding.id}`, history);
    saveHistoryValidity(this.state, input);
  }
}

export function workingHistory(
  state: State,
  input: RunContext,
  messages: ModelMessage[],
  draft: Message,
  cutoff: number,
): ModelHistoryEntry[] {
  const s = state.storage;
  const conversation = s.messages(draft.conversationId);
  const previous =
    s.metadata<ModelHistoryEntry[]>(`history:${input.binding.id}`) ??
    modelMessageHistory(
      conversation.filter((message) => message.sequence <= cutoff),
      input.bot.id,
      (artifactId) => modelImage(s.get('artifacts', artifactId)),
    );
  const source = conversation.filter((message) => message.sequence <= cutoff).at(-1) ?? draft;
  const checkpoint = s
    .byField<ContextCheckpoint>('context_checkpoints', 'bindingId', input.binding.id)
    .at(-1);
  const matchHistory = historyMatcher(previous);
  let currentSource = source;
  const sources = runMessageSources(s, input.runId);
  const replies = conversation.filter(
    (message) =>
      message.runId && sources.has(message.runId) && message.authorBotId === input.bot.id,
  );
  const userSequences = messages.flatMap((message) =>
    message.sourceSequence !== undefined ? [message.sourceSequence] : [],
  );
  const initialUser = messages.findIndex(
    (message, index) =>
      index >= input.messages.length && message.role === 'user' && !message.appContext,
  );
  return messages.map((message, index) => {
    if (message.sourceMessageId && message.sourceSequence !== undefined) {
      if (index >= input.messages.length)
        currentSource = s.getMessage(message.sourceMessageId) ?? currentSource;
      return { messageId: message.sourceMessageId, sequence: message.sourceSequence, message };
    }
    if (index < input.messages.length || message.contextSummary) {
      if (checkpoint && message.content === `此前对话摘要（历史资料）：\n${checkpoint.content}`)
        return {
          messageId: checkpoint.sourceMessageIds.at(-1) ?? source.id,
          sequence: checkpoint.throughSequence,
          message,
        };
      const match = matchHistory(message);
      if (match >= 0) return previous[match];
      return { messageId: source.id, sequence: source.sequence, message };
    }
    if (message.appContext || index === initialUser)
      return { messageId: source.id, sequence: source.sequence, message };
    const nextUser =
      userSequences.find((sequence) => sequence > currentSource.sequence) ?? Infinity;
    const reply =
      replies.find((item) => item.sequence > currentSource.sequence && item.sequence < nextUser) ??
      currentSource;
    return { messageId: reply.id, sequence: reply.sequence, message };
  });
}

export function projectedHistory(
  history: ModelHistoryEntry[],
  messages: ModelMessage[],
): ModelHistoryEntry[] {
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
    const key = JSON.stringify(entry.message);
    const value = positions.get(key) ?? { indices: [], offset: 0 };
    value.indices.push(index);
    positions.set(key, value);
  });
  let cursor = 0;
  return (message: ModelMessage) => {
    const value = positions.get(JSON.stringify(message));
    if (!value) return -1;
    while (value.offset < value.indices.length && value.indices[value.offset] < cursor)
      value.offset++;
    const match = value.indices[value.offset++] ?? -1;
    if (match >= 0) cursor = match + 1;
    return match;
  };
}

interface HistoryValidity {
  generation: number;
  signature: string;
  sourceIds: string[];
  sourceHash: string;
}
export function saveHistoryValidity(state: State, input: RunContext) {
  const sources = state.storage
    .messages(input.binding.conversationId)
    .filter((message) => message.status === 'committed');
  state.storage.setMetadata(`history-validity:${input.binding.id}`, {
    generation: input.binding.generation,
    signature: contextCompatibilityHash({ ...input, protocol: input.connection.protocol }),
    sourceIds: sources.map((message) => message.id),
    sourceHash: contextSourceHash(sources),
  } satisfies HistoryValidity);
}
