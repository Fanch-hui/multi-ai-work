import { describe, expect, it } from 'vitest';
import type { ModelImage, ModelMessage, RunContext } from '../src/domain/provider.js';
import { IMAGE_INPUT_LIMIT, IMAGE_INPUT_TARGET, prepareImageInputBudget, projectImageInputs,
  type ImageInputSize } from '../src/core/image-input-budget.js';

const image = (artifactId: string): ModelImage => ({ artifactId, mimeType: 'image/png' });
const mb = 1024 * 1024;

describe('managed image input budget', () => {
  it('deduplicates exact image content without changing the original records or tool pairing', () => {
    const original = image('original'), duplicate = image('duplicate');
    const messages: ModelMessage[] = [{ role: 'user', content: 'Inspect', images: [original, original] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_artifact', arguments: '{}' }] },
      { role: 'tool', callId: 'read', content: '{"status":"ok"}', images: [duplicate] }];
    const before = structuredClone(messages);
    const sizes = new Map(['original', 'duplicate'].map(id => [id, { key: 'same-pixels', bytes: mb }]));
    const next = projectImageInputs(messages, sizes, 0)!;
    expect(messages).toEqual(before);
    expect(next[0].images).toEqual([original]);
    expect(next[0].imageReferences).toEqual([original]);
    expect(next[1]).toBe(messages[1]);
    expect(next[2]).toMatchObject({ role: 'tool', callId: 'read', content: messages[2].content,
      imageReferences: [duplicate], contextArtifactIds: ['duplicate'] });
    expect(next[2].images).toBeUndefined();
    expect(projectImageInputs(next, sizes, 0)).toBeUndefined();
  });

  it('retires older images in a batch and leaves a stable prefix below the next high watermark', () => {
    const messages: ModelMessage[] = ['first', 'second', 'third'].flatMap(id => [
      { role: 'user', content: id, images: [image(id)] }, { role: 'assistant', content: 'Observed' },
    ]);
    messages.push({ role: 'user', content: 'Continue' });
    const sizes = new Map(['first', 'second', 'third'].map(id => [id, { key: id, bytes: mb }]));
    const next = projectImageInputs(messages, sizes, 6)!;
    expect(next.flatMap(message => message.images ?? []).map(image => image.artifactId)).toEqual(['third']);
    expect(next.flatMap(message => message.imageReferences ?? []).map(image => image.artifactId)).toEqual(['first', 'second']);
    expect(next.slice(-3)).toEqual(messages.slice(-3));
    const grown = [...next, { role: 'assistant' as const, content: 'Next', images: [image('new')] }];
    sizes.set('new', { key: 'new', bytes: .6 * mb });
    expect(projectImageInputs(grown, sizes, 6)).toBeUndefined();
    expect(IMAGE_INPUT_TARGET).toBeLessThan(IMAGE_INPUT_LIMIT);
  });

  it('protects current user inputs and the latest tool batch even when they exceed the soft target', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Previous', images: [image('old')] },
      { role: 'assistant', content: 'Observed' }, { role: 'user', content: 'Compare', images: [image('user')] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_artifact', arguments: '{}' },
        { id: 'b', name: 'read_artifact', arguments: '{}' }] },
      { role: 'tool', callId: 'a', content: 'Page A', images: [image('a')] },
      { role: 'tool', callId: 'b', content: 'Page B', images: [image('b')] }];
    const sizes = new Map(['old', 'user', 'a', 'b'].map(id => [id, { key: id, bytes: mb }]));
    const next = projectImageInputs(messages, sizes, 2)!;
    expect(next[0].imageReferences).toEqual([image('old')]);
    expect(next.slice(2)).toEqual(messages.slice(2));
    expect(projectImageInputs(next, sizes, 2)).toBeUndefined();
    const consumed = [...next, { role: 'assistant' as const, content: 'Compared both pages' }];
    const later = projectImageInputs(consumed, sizes, 2)!;
    expect(later.flatMap(message => message.images ?? []).map(image => image.artifactId)).toEqual(['user']);
  });

  it('keeps opaque Responses data and existing readable references intact', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: '', images: [image('old')],
      imageReferences: [image('prior')], contextArtifactIds: ['prior'] },
    { role: 'assistant', content: '', providerItems: [{ type: 'reasoning', encrypted_content: 'opaque' }] },
    { role: 'user', content: 'New', images: [image('new')] }];
    const sizes = new Map<string, ImageInputSize>([['old', { key: 'old', bytes: 2 * mb }], ['new', { key: 'new', bytes: mb }]]);
    const next = projectImageInputs(messages, sizes, 2)!;
    expect(next[0].imageReferences?.map(image => image.artifactId)).toEqual(['prior', 'old']);
    expect(next[0].contextArtifactIds).toEqual(['prior', 'old']);
    expect(next[1]).toBe(messages[1]);
    expect(next[2]).toBe(messages[2]);
  });

  it('only projects images when the agent can read the saved originals again', async () => {
    const context = { tools: [], resolveImage: async () => { throw new Error('must not read'); } } as unknown as RunContext;
    expect(prepareImageInputBudget(context)).toBeUndefined();
  });

  it('measures actual encoded bytes, resolves each attachment once and skips reference-only history', async () => {
    const resolved: string[] = [];
    const context = { tools: [{ name: 'read_artifact' }], signal: new AbortController().signal,
      resolveImage: async (image: ModelImage) => { resolved.push(image.artifactId); return { mimeType: image.mimeType, data: 'same' }; },
    } as unknown as RunContext;
    const messages: ModelMessage[] = [{ role: 'user', content: '', images: [image('a'), image('a')] },
      { role: 'tool', content: '', callId: 'read', images: [image('b')], imageReferences: [image('prior')] }];
    const next = await prepareImageInputBudget(context)!(messages, { currentStart: 0 });
    expect(resolved).toEqual(['a', 'b']);
    expect(next?.flatMap(message => message.images ?? [])).toEqual([image('a')]);
    expect(next?.[1].imageReferences).toEqual([image('prior'), image('b')]);
  });
});
