import type { ModelImage, ModelMessage } from '../domain/provider.js';
import type { Message, Protocol } from '../domain/types.js';

export interface ModelHistoryEntry {
  sequence: number;
  messageId: string;
  message: ModelMessage;
}

/** Plain conversation fallback; native protocol items must come from persisted provider history. */
export function modelMessageHistory(messages: Message[], botId?: string,
  resolveImage?: (artifactId: string) => ModelImage | undefined): ModelHistoryEntry[] {
  return messages.filter(message => message.status === 'committed' && message.authorType !== 'system')
    .sort((a, b) => a.sequence - b.sequence).map(message => ({
      sequence: message.sequence,
      messageId: message.id,
      message: {
        role: message.authorType === 'bot' && (!botId || message.authorBotId === botId) ? 'assistant' : 'user',
        content: message.authorType === 'bot' && botId && message.authorBotId !== botId
          ? `[成员 ${message.authorBotId}] ${message.content}` : message.content,
        ...(resolveImage && message.artifactIds.length && (message.authorType === 'user' || botId && message.authorBotId !== botId) ? { images: message.artifactIds
          .map(resolveImage).filter((image): image is ModelImage => Boolean(image)) } : {}),
      },
    }));
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ModelMessage>;
  return ['user', 'assistant', 'tool'].includes(item.role ?? '') && typeof item.content === 'string';
}

function messageProjection(message: ModelMessage, protocol: Protocol): unknown {
  if (protocol === 'responses' && message.providerItems?.length) return message.providerItems;
  return {
    role: message.role, content: message.content,
    ...(message.callId ? { callId: message.callId } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.images?.length ? { images: message.images.map(image => ({ artifactId: image.artifactId })) } : {}),
  };
}

/** Opaque state has unknown provider cost; reserve fixed overhead without treating ciphertext as prose. */
const opaqueEstimate = '[opaque provider state]'.padEnd(256, ' ');

function estimateValue(value: unknown, protocol: Protocol): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, item) => {
    if (key === 'encrypted_content') return opaqueEstimate;
    return isModelMessage(item) ? messageProjection(item, protocol) : item;
  }) ?? '';
  const visible = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]');
  const cjkCount = (visible.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  return Math.ceil(cjkCount + (visible.length - cjkCount) / 4);
}

export function estimateTokens(value: unknown): number {
  if (Array.isArray(value) && value.every(isModelMessage)) return estimateModelMessagesTokens(value);
  return estimateValue(value, 'responses');
}

export function estimateModelMessageTokens(message: ModelMessage, protocol: Protocol = 'responses'): number {
  // Images are resolved later by the Provider; keep a conservative allowance per referenced image.
  return 4 + estimateValue(messageProjection(message, protocol), protocol) + (message.images?.length ?? 0) * 1024;
}

export function estimateModelMessagesTokens(messages: ModelMessage[], protocol: Protocol = 'responses'): number {
  return messages.reduce((total, message) => total + estimateModelMessageTokens(message, protocol), 0);
}

function providerText(items: unknown[]): string {
  return items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (value.type === 'reasoning') return [];
    if (typeof value.text === 'string') return [value.text];
    if (typeof value.output === 'string') return [value.output];
    if (typeof value.content === 'string') return [value.content];
    return Array.isArray(value.content) ? [providerText(value.content)] : [];
  }).filter(Boolean).join('\n');
}

/** Readable history for summarization; replay continues to use the original protocol records. */
export function summaryMessageProjection(message: ModelMessage): unknown {
  const content = message.content || providerText(message.providerItems ?? []);
  return {
    role: message.role, content,
    ...(message.callId ? { callId: message.callId } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.images?.length ? { imageArtifactIds: message.images.map(image => image.artifactId) } : {}),
  };
}

/** A cut is valid only when every preceding tool call has received its result. */
export function balancedHistoryUnits(history: ModelHistoryEntry[]): ModelHistoryEntry[][] {
  const units: ModelHistoryEntry[][] = [];
  const pending = new Set<string>();
  let unit: ModelHistoryEntry[] = [];
  let valid = true;
  for (const entry of history) {
    unit.push(entry);
    for (const call of entry.message.toolCalls ?? []) {
      if (pending.has(call.id)) valid = false;
      pending.add(call.id);
    }
    if (entry.message.role === 'tool' && (!entry.message.callId || !pending.delete(entry.message.callId))) valid = false;
    if (valid && !pending.size) { units.push(unit); unit = []; }
  }
  if (unit.length) units.push(unit);
  return units;
}

export function historyUnits(history: ModelHistoryEntry[]): ModelHistoryEntry[][] {
  const units: ModelHistoryEntry[][] = [];
  for (const entry of history) {
    if (entry.message.role === 'user' || units.length === 0) units.push([]);
    units[units.length - 1].push(entry);
  }
  return units;
}

export function toolsPaired(unit: ModelHistoryEntry[]): boolean {
  const pending = new Set<string>();
  for (const { message } of unit) {
    for (const call of message.toolCalls ?? []) {
      if (pending.has(call.id)) return false;
      pending.add(call.id);
    }
    if (message.role === 'tool') {
      if (!message.callId || !pending.delete(message.callId)) return false;
    }
  }
  return pending.size === 0;
}
