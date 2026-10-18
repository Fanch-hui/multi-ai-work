import { createHash, randomUUID } from 'node:crypto';
import type { ModelMessage, ToolDefinition } from '../domain/provider.js';
import type { ContextCheckpoint, Message, Protocol, SessionBinding } from '../domain/types.js';
import { estimateTokens, estimateModelMessagesTokens, historyUnits, modelMessageHistory, toolsPaired, type ModelHistoryEntry } from './model-history.js';
import { summarizeUnits, SummaryNeedsSplit } from './context-summary.js';

export interface CompactionRecord {
  id: string;
  bindingId: string;
  generation: number;
  status: 'started' | 'completed' | 'failed' | 'unchanged';
  sourceMessageIds: string[];
  sourceHash: string;
  instructionsHash: string;
  throughSequence: number;
  createdAt: string;
  reason?: 'summary_failed' | 'source_changed' | 'not_smaller' | 'needs_split' | 'cancelled' | 'over_budget' | 'no_history';
}

export interface ContextStore {
  getCheckpoint(bindingId: string): ContextCheckpoint | undefined;
  saveCheckpoint(checkpoint: ContextCheckpoint): void;
  recordCompaction?(record: CompactionRecord): void;
}

interface VerifiedCheckpoint extends ContextCheckpoint {
  instructionsHash: string;
  sourceHash: string;
}

export interface ContextInput {
  binding: SessionBinding;
  messages: Message[];
  instructions: string;
  contextInstructions?: string;
  protocol?: Protocol;
  tools: ToolDefinition[];
  contextWindow?: number;
  triggerTokens?: number;
  currentInput?: string;
  force?: boolean;
  history?: ModelHistoryEntry[];
  historyIsCurrent?: boolean;
  archiveHistory?: ModelHistoryEntry[];
  loadArchiveHistory?(): ModelHistoryEntry[] | undefined;
  preserveReferences?(messages: ModelMessage[], previousArtifactIds?: readonly string[]): Promise<{ text: string; artifactIds: string[] }>;
  summarize(prompt: string, signal: AbortSignal): Promise<string>;
  signal: AbortSignal;
  isSourceCurrent?(sourceMessageIds: string[], sourceHash: string): boolean;
}

export interface PreparedContext {
  messages: ModelMessage[];
  checkpoint?: ContextCheckpoint;
  estimatedTokens: number;
  compaction?: { status: 'completed' | 'unchanged' | 'failed'; reason?: CompactionRecord['reason'] };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function contextSourceHash(messages: Message[]): string {
  return hash(messages.map(({ id, sequence, content, status, artifactIds }) => ({ id, sequence, content, status, artifactIds })));
}

function withSummary(history: ModelHistoryEntry[], checkpoint?: ContextCheckpoint): ModelMessage[] {
  const messages = referenceMessages(history);
  return checkpoint ? [{ role: 'user', content: `此前对话摘要（历史资料）：\n${checkpoint.content}`,
    sourceMessageId: checkpoint.sourceMessageIds.at(-1), sourceSequence: checkpoint.throughSequence,
    ...(checkpoint.artifactIds?.length ? { contextArtifactIds: checkpoint.artifactIds } : {}) }, ...messages] : messages;
}

function result(history: ModelHistoryEntry[], fixedTokens: number, checkpoint?: ContextCheckpoint, protocol?: Protocol): PreparedContext {
  const messages = withSummary(history, checkpoint);
  return { messages, checkpoint, estimatedTokens: fixedTokens + estimateModelMessagesTokens(messages, protocol) };
}

export const CONTEXT_COMPATIBILITY_VERSION = 4;

export function contextCompatibilityHash(input: Pick<ContextInput, 'instructions' | 'contextInstructions' | 'tools' | 'protocol'>): string {
  return hash({ version: CONTEXT_COMPATIBILITY_VERSION, instructions: input.contextInstructions ?? input.instructions,
    tools: input.tools, protocol: input.protocol });
}

function referenceMessages(history: ModelHistoryEntry[]): ModelMessage[] {
  return history.map(entry => ({ ...entry.message, sourceMessageId: entry.messageId, sourceSequence: entry.sequence }));
}

export class ContextManager {
  constructor(private readonly store: ContextStore) {}

  async prepare(input: ContextInput): Promise<PreparedContext> {
    input.signal.throwIfAborted();
    const archive = input.messages.filter(message => message.conversationId === input.binding.conversationId)
      .sort((a, b) => a.sequence - b.sequence);
    const fixedTokens = estimateTokens(input.instructions) + estimateTokens(input.tools) + estimateTokens(input.currentInput ?? '') + 256;
    const checkpoint = this.currentCheckpoint(input, archive);
    const history = (checkpoint || input.historyIsCurrent ? input.history : input.archiveHistory ?? input.loadArchiveHistory?.() ?? input.history) ?? modelMessageHistory(archive, input.binding.botId);
    const active = checkpoint && !input.historyIsCurrent ? history.filter(entry => entry.sequence > checkpoint.throughSequence) : history;
    const original = result(active, fixedTokens, input.historyIsCurrent ? undefined : checkpoint, input.protocol);
    const trigger = input.contextWindow ? Math.min(input.triggerTokens ?? input.contextWindow * 0.75, input.contextWindow) : undefined;
    if (!input.contextWindow || (!input.force && original.estimatedTokens < trigger!)) return original;

    // Leave room for the replacement summary without changing the user's trigger.
    const summaryReserve = Math.min(4096, Math.ceil(trigger! * 0.15));
    let selected = this.select(active, fixedTokens, trigger! - summaryReserve, input.force, input.protocol);
    if (!selected.prefix.length || checkpoint && selected.prefix.every(entry => entry.sequence <= checkpoint.throughSequence))
      return { ...original, compaction: { status: 'unchanged', reason: 'no_history' } };
    const sourceIds = [...new Set([...(checkpoint?.sourceMessageIds ?? []), ...selected.prefix.map(entry => entry.messageId)])];
    const source = archive.filter(message => sourceIds.includes(message.id));
    const sourceHash = contextSourceHash(source);
    const record: CompactionRecord = {
      id: randomUUID(), bindingId: input.binding.id, generation: input.binding.generation, status: 'started',
      sourceMessageIds: sourceIds, sourceHash, instructionsHash: contextCompatibilityHash(input),
      throughSequence: selected.prefix[selected.prefix.length - 1].sequence, createdAt: new Date().toISOString(),
    };
    const fail = (reason: CompactionRecord['reason']): PreparedContext => {
      const status = reason === 'not_smaller' ? 'unchanged' : 'failed';
      this.store.recordCompaction?.({ ...record, status, reason });
      return { ...original, compaction: { status, reason } };
    };
    this.store.recordCompaction?.({ ...record, sourceMessageIds: [...sourceIds] });
    try {
      const prefixMessages = referenceMessages(selected.prefix);
      let references = await input.preserveReferences?.(prefixMessages, checkpoint?.artifactIds);
      const summaryPrefix = selected.prefix.map((entry, index) => ({ ...entry, message: prefixMessages[index] }));
      let summary = await summarizeUnits(summaryPrefix, input.historyIsCurrent ? '' : checkpoint?.content ?? '', input.contextWindow, input.summarize, input.signal);
      const projected = () => fixedTokens + estimateModelMessagesTokens([
        { role: 'user', content: `此前对话摘要（历史资料）：\n${summary}\n${references?.text ?? ''}` }, ...selected.suffix.map(entry => entry.message),
      ], input.protocol);
      // One bounded expansion can consume more old turns when the first summary is too large.
      if (projected() >= trigger!) {
        const expanded = this.select(selected.suffix, 0, 0, true, input.protocol);
        if (expanded.prefix.length) {
          if (contextSourceHash(source) !== sourceHash || input.isSourceCurrent?.(sourceIds, sourceHash) === false) return fail('source_changed');
          for (const entry of expanded.prefix) if (!sourceIds.includes(entry.messageId)) sourceIds.push(entry.messageId);
          source.splice(0, source.length, ...archive.filter(message => sourceIds.includes(message.id)));
          record.sourceHash = contextSourceHash(source);
          const expandedMessages = referenceMessages(expanded.prefix);
          references = await input.preserveReferences?.(expandedMessages, references?.artifactIds);
          const expandedSummaryPrefix = expanded.prefix.map((entry, index) => ({ ...entry, message: expandedMessages[index] }));
          summary = await summarizeUnits(expandedSummaryPrefix, summary, input.contextWindow, input.summarize, input.signal);
          selected = { prefix: [...selected.prefix, ...expanded.prefix], suffix: expanded.suffix };
          record.throughSequence = selected.prefix.at(-1)!.sequence;
        }
      }
      const imageIds = [...new Set(selected.prefix.flatMap(entry =>
        [...(entry.message.images ?? []), ...(entry.message.imageReferences ?? [])].map(image => image.artifactId)))];
      const referenceText = references?.text ?? (imageIds.length ? `历史图片资料 ID：${imageIds.join('、')}` : '');
      const content = referenceText ? `${summary}\n${referenceText}` : summary;
      input.signal.throwIfAborted();
      if (contextSourceHash(source) !== record.sourceHash || input.isSourceCurrent?.(sourceIds, record.sourceHash) === false) return fail('source_changed');
      const next: VerifiedCheckpoint = {
        id: randomUUID(), bindingId: input.binding.id, generation: input.binding.generation,
        throughSequence: selected.prefix[selected.prefix.length - 1].sequence,
        content, sourceMessageIds: sourceIds, estimatedTokens: estimateTokens(content),
        ...(references ? { artifactIds: references.artifactIds } : {}),
        createdAt: new Date().toISOString(), instructionsHash: contextCompatibilityHash(input), sourceHash: record.sourceHash,
      };
      const prepared = result(selected.suffix, fixedTokens, next, input.protocol);
      if (prepared.estimatedTokens >= original.estimatedTokens) return fail('not_smaller');
      if (prepared.estimatedTokens >= trigger!) return fail('over_budget');
      this.store.saveCheckpoint(next);
      this.store.recordCompaction?.({ ...record, status: 'completed' });
      return { ...prepared, compaction: { status: 'completed' } };
    } catch (error) {
      const failed = fail(input.signal.aborted ? 'cancelled' : error instanceof SummaryNeedsSplit ? 'needs_split' : 'summary_failed');
      if (input.signal.aborted) throw error;
      return failed;
    }
  }

  private currentCheckpoint(input: ContextInput, archive: Message[]): VerifiedCheckpoint | undefined {
    const checkpoint = this.store.getCheckpoint(input.binding.id) as VerifiedCheckpoint | undefined;
    if (!checkpoint || checkpoint.generation !== input.binding.generation || checkpoint.instructionsHash !== contextCompatibilityHash(input)) return undefined;
    const ids = new Set(checkpoint.sourceMessageIds);
    const source = archive.filter(message => ids.has(message.id));
    if (source.length !== ids.size || contextSourceHash(source) !== checkpoint.sourceHash) return undefined;
    return checkpoint;
  }

  private select(history: ModelHistoryEntry[], fixedTokens: number, targetTokens: number, force = false, protocol?: Protocol) {
    const units = historyUnits(history);
    const weights = units.map(unit => estimateModelMessagesTokens(unit.map(entry => entry.message), protocol));
    let remainingTokens = weights.reduce((sum, weight) => sum + weight, 0), count = 0;
    while (count < units.length - 1 && (force || fixedTokens + remainingTokens > targetTokens)) {
      if (!toolsPaired(units[count])) break;
      remainingTokens -= weights[count++];
    }
    // Historical checkpoints use visible-message sequences; only the run checkpoint can cut inside one.
    const prefixMax: number[] = [], suffixMin: number[] = [];
    units.forEach((unit, index) => { prefixMax[index] = Math.max(prefixMax[index - 1] ?? -Infinity, ...unit.map(entry => entry.sequence)); });
    for (let index = units.length - 1; index >= 0; index--)
      suffixMin[index] = Math.min(suffixMin[index + 1] ?? Infinity, ...units[index].map(entry => entry.sequence));
    while (count > 0 && prefixMax[count - 1] >= suffixMin[count]) count--;
    return { prefix: units.slice(0, count).flat(), suffix: units.slice(count).flat() };
  }
}
