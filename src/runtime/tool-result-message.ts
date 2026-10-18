import type { ModelImage, ModelMessage } from '../domain/provider.js';

export function toolResultMessage(callId: string, result: unknown): ModelMessage {
  const value = result as { content?: unknown; isError?: boolean } | null;
  if (!value || !Array.isArray(value.content) || !value.content.every(part =>
    part && typeof part === 'object' && (part.type === 'text' && typeof part.text === 'string'
      || part.type === 'image' && typeof part.image?.artifactId === 'string' && typeof part.image?.mimeType === 'string'))) {
    return { role: 'tool', callId, content: typeof result === 'string' ? result : JSON.stringify(result) ?? 'null' };
  }
  const images: ModelImage[] = value.content.filter(part => part.type === 'image').map(part => part.image);
  const text = value.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return { role: 'tool', callId, content: value.isError ? `工具返回错误：${text}` : text,
    ...(images.length ? { images } : {}) };
}
