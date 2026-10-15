import { createHash, randomUUID } from 'node:crypto';
import type { ModelMessage, ToolDefinition } from '../domain/provider.js';
import type { ContextCheckpoint, Message, SessionBinding } from '../domain/types.js';
import { estimateTokens, historyUnits, modelMessageHistory, toolsPaired, type ModelHistoryEntry } from './model-history.js';
import { summarizeUnits, SummaryNeedsSplit } from './context-summary.js';

export interface CompactionRecord {
  id: string;
  bindingId: string;
  generation: number;
  status: 'started' | 'completed' | 'failed';
  sourceMessageIds: string[];
  sourceHash: string;
  instructionsHash: string;
  throughSequence: number;
  createdAt: string;
  reason?: 'summary_failed' | 'source_changed' | 'not_smaller' | 'needs_split' | 'cancelled';
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
  tools: ToolDefinition[];
  contextWindow?: number;
  triggerTokens?: number;
  currentInput?: string;
  force?: boolean;
  history?: ModelHistoryEntry[];
  archiveHistory?: ModelHistoryEntry[];
  summarize(prompt: string, signal: AbortSignal): Promise<string>;
  signal: AbortSignal;
  isSourceCurrent?(sourceMessageIds: string[], sourceHash: string): boolean;
}

export interface PreparedContext {
  messages: ModelMessage[];
  checkpoint?: ContextCheckpoint;
  estimatedTokens: number;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function contextSourceHash(messages: Message[]): string {
  return hash(messages.map(({ id, sequence, content, status, artifactIds }) => ({ id, sequence, content, status, artifactIds })));
}

function withSummary(history: ModelHistoryEntry[], checkpoint?: ContextCheckpoint): ModelMessage[] {
  const messages = history.map(entry => entry.message);
  return checkpoint ? [{ role: 'user', content: `此前对话摘要（历史资料）：\n${checkpoint.content}` }, ...messages] : messages;
}

function result(history: ModelHistoryEntry[], fixedTokens: number, checkpoint?: ContextCheckpoint): PreparedContext {
  const messages = withSummary(history, checkpoint);
  return { messages, checkpoint, estimatedTokens: fixedTokens + estimateTokens(messages) };
}

export class ContextManager {
  constructor(private readonly store: ContextStore) {}

  async prepare(input: ContextInput): Promise<PreparedContext> {
    input.signal.throwIfAborted();
    const archive = input.messages.filter(message => message.conversationId === input.binding.conversationId)
      .sort((a, b) => a.sequence - b.sequence);
    const fixedTokens = estimateTokens(input.instructions) + estimateTokens(input.tools) + estimateTokens(input.currentInput ?? '') + 256;
    const checkpoint = this.currentCheckpoint(input, archive);
    const history = (checkpoint ? input.history : input.archiveHistory ?? input.history) ?? modelMessageHistory(archive, input.binding.botId);
    const active = checkpoint ? history.filter(entry => entry.sequence > checkpoint.throughSequence) : history;
    const original = result(active, fixedTokens, checkpoint);
    const trigger = input.triggerTokens ?? (input.contextWindow ? input.contextWindow * 0.75 : undefined);
    if (!input.contextWindow || (!input.force && original.estimatedTokens < trigger!)) return original;

    const selected = this.select(active, fixedTokens, Math.min(input.contextWindow * 0.6, trigger! * 0.8), input.force);
    if (selected.prefix.length === 0) return original;
    const sourceIds = [...new Set([...(checkpoint?.sourceMessageIds ?? []), ...selected.prefix.map(entry => entry.messageId)])];
    const source = archive.filter(message => sourceIds.includes(message.id));
    const sourceHash = contextSourceHash(source);
    const record: CompactionRecord = {
      id: randomUUID(), bindingId: input.binding.id, generation: input.binding.generation, status: 'started',
      sourceMessageIds: sourceIds, sourceHash, instructionsHash: hash(input.instructions),
      throughSequence: selected.prefix[selected.prefix.length - 1].sequence, createdAt: new Date().toISOString(),
    };
    const fail = (reason: CompactionRecord['reason']) => {
      this.store.recordCompaction?.({ ...record, status: 'failed', reason });
      return original;
    };
    this.store.recordCompaction?.(record);
    try {
      const summary = await summarizeUnits(selected.prefix, checkpoint?.content ?? '', input.contextWindow, input.summarize, input.signal);
      const imageIds = [...new Set(selected.prefix.flatMap(entry => entry.message.images?.map(image => image.artifactId) ?? []))];
      const content = imageIds.length ? `${summary}\n历史图片资料 ID（可用 read_artifact 查阅）：${imageIds.join('、')}` : summary;
      input.signal.throwIfAborted();
      if (contextSourceHash(source) !== sourceHash || input.isSourceCurrent?.(sourceIds, sourceHash) === false) return fail('source_changed');
      const next: VerifiedCheckpoint = {
        id: randomUUID(), bindingId: input.binding.id, generation: input.binding.generation,
        throughSequence: selected.prefix[selected.prefix.length - 1].sequence,
        content, sourceMessageIds: sourceIds, estimatedTokens: estimateTokens(content),
        createdAt: new Date().toISOString(), instructionsHash: hash(input.instructions), sourceHash,
      };
      const prepared = result(selected.suffix, fixedTokens, next);
      if (prepared.estimatedTokens >= original.estimatedTokens) return fail('not_smaller');
      this.store.saveCheckpoint(next);
      this.store.recordCompaction?.({ ...record, status: 'completed' });
      return prepared;
    } catch (error) {
      const failed = fail(input.signal.aborted ? 'cancelled' : error instanceof SummaryNeedsSplit ? 'needs_split' : 'summary_failed');
      if (input.signal.aborted) throw error;
      return failed;
    }
  }

  private currentCheckpoint(input: ContextInput, archive: Message[]): VerifiedCheckpoint | undefined {
    const checkpoint = this.store.getCheckpoint(input.binding.id) as VerifiedCheckpoint | undefined;
    if (!checkpoint || checkpoint.generation !== input.binding.generation || checkpoint.instructionsHash !== hash(input.instructions)) return undefined;
    const ids = new Set(checkpoint.sourceMessageIds);
    const source = archive.filter(message => ids.has(message.id));
    if (source.length !== ids.size || contextSourceHash(source) !== checkpoint.sourceHash) return undefined;
    return checkpoint;
  }

  private select(history: ModelHistoryEntry[], fixedTokens: number, targetTokens: number, force = false) {
    const units = historyUnits(history);
    const prefix: ModelHistoryEntry[] = [];
    const remaining = [...units];
    while (remaining.length > 1 && ((force && prefix.length === 0) || fixedTokens + estimateTokens(remaining.flat().map(entry => entry.message)) > targetTokens)) {
      if (!toolsPaired(remaining[0])) break;
      prefix.push(...remaining.shift()!);
    }
    return { prefix, suffix: remaining.flat() };
  }
}
