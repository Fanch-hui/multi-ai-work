import type { ModelImage, ModelMessage } from '../domain/provider.js';
import type { Message } from '../domain/types.js';

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

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
    : JSON.stringify(value, (_key, item) => typeof item === 'string'
      ? item.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]') : item) ?? '';
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
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
