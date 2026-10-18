import { createHash } from 'node:crypto';
import type { ModelMessage, RunContext } from '../domain/provider.js';

export const IMAGE_INPUT_LIMIT = 2 * 1024 * 1024;
export const IMAGE_INPUT_TARGET = 1.5 * 1024 * 1024;
export interface ImageInputSize { key: string; bytes: number; }

export function prepareImageInputBudget(input: RunContext): RunContext['prepareImageInputs'] {
  if (!input.resolveImage || !input.tools.some(tool => tool.name === 'read_artifact')) return;
  return async (messages, { currentStart }) => {
    const images = new Map(messages.filter(message => !message.providerItems?.length)
      .flatMap(message => message.images ?? []).map(image => [image.artifactId, image]));
    if (!images.size) return;
    const sizes = new Map<string, ImageInputSize>();
    for (const image of images.values()) {
      input.signal.throwIfAborted();
      const value = await input.resolveImage!(image);
      input.signal.throwIfAborted();
      sizes.set(image.artifactId, {
        key: createHash('sha256').update(value.mimeType).update('\0').update(value.data).digest('hex'),
        bytes: value.data.length + `data:${value.mimeType};base64,`.length,
      });
    }
    return projectImageInputs(messages, sizes, currentStart);
  };
}

/** Image changes only affect the working projection; callers persist the original history first. */
export function projectImageInputs(messages: ModelMessage[], sizes: ReadonlyMap<string, ImageInputSize>, currentStart: number,
  limit = IMAGE_INPUT_LIMIT, target = IMAGE_INPUT_TARGET): ModelMessage[] | undefined {
  const removed = new Map<number, Set<number>>();
  const unique = new Map<string, { index: number; position: number; bytes: number }>();
  const protect = protectedImages(messages, sizes, currentStart);
  for (const [index, message] of messages.entries()) {
    if (message.providerItems?.length) continue;
    for (const [position, image] of (message.images ?? []).entries()) {
      const size = sizes.get(image.artifactId);
      if (!size) continue;
      if (unique.has(size.key)) remove(index, position);
      else unique.set(size.key, { index, position, bytes: size.bytes });
    }
  }
  let bytes = [...unique.values()].reduce((total, item) => total + item.bytes, 0);
  if (bytes > limit) {
    for (const [key, item] of unique) {
      if (bytes <= target) break;
      if (protect.has(key)) continue;
      remove(item.index, item.position);
      bytes -= item.bytes;
    }
  }
  if (!removed.size) return;
  return messages.map((message, index) => {
    const omitted = removed.get(index);
    if (!omitted) return message;
    const references = new Map([...(message.imageReferences ?? []), ...[...omitted].map(position => message.images![position])]
      .map(image => [image.artifactId, image]));
    const images = message.images?.filter((_image, position) => !omitted.has(position));
    return { ...message, images: images?.length ? images : undefined,
      imageReferences: [...references.values()],
      contextArtifactIds: [...new Set([...(message.contextArtifactIds ?? []), ...references.keys()])],
    };
  });

  function remove(index: number, position: number) {
    const images = removed.get(index) ?? new Set<number>();
    images.add(position); removed.set(index, images);
  }
}

function protectedImages(messages: ModelMessage[], sizes: ReadonlyMap<string, ImageInputSize>, currentStart: number) {
  const keys = new Set<string>();
  let lastAssistant = messages.length - 1;
  while (lastAssistant >= 0 && messages[lastAssistant].role !== 'assistant') lastAssistant--;
  for (const [index, message] of messages.entries()) {
    const userInput = index >= currentStart && message.role === 'user' && !message.appContext && !message.contextSummary;
    const freshTool = index > lastAssistant && index >= currentStart && message.role === 'tool';
    if (!userInput && !freshTool) continue;
    for (const image of message.images ?? []) {
      const key = sizes.get(image.artifactId)?.key;
      if (key) keys.add(key);
    }
  }
  return keys;
}
