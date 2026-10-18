import { describe, expect, it } from 'vitest';
import type { ModelImage, ModelMessage } from '../src/domain/provider.js';
import { chatInput, responsesInput } from '../src/providers/managed/messages.js';
import { modelMessageContent } from '../src/runtime/image-references.js';
import { estimateModelMessageTokens, summaryMessageProjection } from '../src/runtime/model-history.js';

const original: ModelImage = { artifactId: 'original-image', mimeType: 'image/png', width: 800, height: 1200 };
const page: ModelImage = { artifactId: 'current-page', mimeType: 'image/png' };
const pageUrl = 'data:image/png;base64,aW1hZ2U=';
const images = new Map([[page.artifactId, pageUrl]]);

describe('historical image references', () => {
  it('keeps original text and remaining images in both protocols', () => {
    const message: ModelMessage = { role: 'user', content: 'Compare the latest page', images: [page], imageReferences: [original] };
    const text = modelMessageContent(message);
    expect(text.startsWith(`${message.content}\n`)).toBe(true);
    expect(text).toContain('read_artifact({"artifactId":"original-image"})');
    expect(chatInput([message], 'Help', images)).toEqual([{ role: 'system', content: 'Help' },
      { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: pageUrl } }] }]);
    expect(responsesInput([message], images)).toEqual([{ role: 'user', content: [
      { type: 'input_text', text }, { type: 'input_image', image_url: pageUrl, detail: 'auto' },
    ] }]);
    expect(message.content).toBe('Compare the latest page');
    expect(message.imageReferences).toEqual([original]);
  });

  it('sends a reference-only message without resolving pixel data', () => {
    const message: ModelMessage = { role: 'user', content: '', imageReferences: [original] };
    const content = modelMessageContent(message);
    expect(chatInput([message], '')[1]).toEqual({ role: 'user', content });
    expect(responsesInput([message])).toEqual([{ role: 'user', content }]);
    expect(content).not.toContain('base64');
  });

  it('keeps references with their tool output and tool images after the complete Chat batch', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_artifact', arguments: '{}' }, { id: 'b', name: 'read_artifact', arguments: '{}' }] },
      { role: 'tool', callId: 'a', content: 'Previous page', imageReferences: [original] },
      { role: 'tool', callId: 'b', content: 'Current page', images: [page] },
      { role: 'assistant', content: 'Compared' },
    ];
    const chat = chatInput(messages, '', images);
    expect(chat.map(message => message.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    expect(chat[2]).toEqual({ role: 'tool', tool_call_id: 'a', content: modelMessageContent(messages[1]) });
    expect(chat[3]).toEqual({ role: 'tool', tool_call_id: 'b', content: 'Current page' });
    expect(chat[4]).toMatchObject({ content: [{ type: 'text', text: '以下图片来自前述工具返回。' },
      { type: 'image_url', image_url: { url: pageUrl } }] });
    const responses = responsesInput(messages, images);
    expect(responses[2]).toEqual({ type: 'function_call_output', call_id: 'a', output: modelMessageContent(messages[1]) });
    expect(responses[3]).toEqual({ type: 'function_call_output', call_id: 'b', output: [
      { type: 'input_text', text: 'Current page' }, { type: 'input_image', image_url: pageUrl, detail: 'auto' },
    ] });
  });

  it('preserves old message serialization when references are absent or empty', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'Question' }, { role: 'assistant', content: '',
      toolCalls: [{ id: 'call', name: 'read_artifact', arguments: '{}' }] }, { role: 'tool', callId: 'call', content: 'Result' },
    { role: 'assistant', content: 'Answer' }];
    const withEmptyReferences = messages.map(message => ({ ...message, imageReferences: [] }));
    expect(JSON.stringify(chatInput(messages, 'Help'))).toBe(JSON.stringify(chatInput(withEmptyReferences, 'Help')));
    expect(JSON.stringify(responsesInput(messages))).toBe(JSON.stringify(responsesInput(withEmptyReferences)));
    expect(messages.map(summaryMessageProjection)).toEqual(withEmptyReferences.map(summaryMessageProjection));
    expect(chatInput(messages, 'Help')).toEqual([{ role: 'system', content: 'Help' }, { role: 'user', content: 'Question' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_artifact', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call', content: 'Result' }, { role: 'assistant', content: 'Answer' }]);
  });

  it('preserves opaque Responses items and their estimate even alongside generic references', () => {
    const providerItems = [{ type: 'reasoning', id: 'reasoning', encrypted_content: 'secret-ciphertext' },
      { type: 'function_call', id: 'fc', call_id: 'call', name: 'read_artifact', arguments: '{}' }];
    const message: ModelMessage = { role: 'assistant', content: '', providerItems, imageReferences: [original] };
    const input = responsesInput([message]);
    expect(input).toEqual(providerItems);
    expect(input[0]).toBe(providerItems[0]);
    expect(input[1]).toBe(providerItems[1]);
    expect(estimateModelMessageTokens(message)).toBe(estimateModelMessageTokens({ ...message, imageReferences: undefined }));
  });

  it('includes generated reference text in estimates and preserves readable IDs in summaries', () => {
    const message: ModelMessage = { role: 'tool', content: 'Rendered page', callId: 'read', imageReferences: [original] };
    const materialized: ModelMessage = { ...message, content: modelMessageContent(message), imageReferences: undefined };
    for (const protocol of ['responses', 'chat-completions'] as const) {
      expect(estimateModelMessageTokens(message, protocol)).toBe(estimateModelMessageTokens(materialized, protocol));
      expect(estimateModelMessageTokens(message, protocol)).toBeGreaterThan(estimateModelMessageTokens({ ...message, imageReferences: undefined }, protocol));
      expect(estimateModelMessageTokens({ ...message, images: [original], imageReferences: undefined }, protocol))
        .toBeGreaterThan(estimateModelMessageTokens(message, protocol));
    }
    expect(summaryMessageProjection(message)).toEqual({ role: 'tool', content: modelMessageContent(message), callId: 'read', imageArtifactIds: [original.artifactId] });
    const assistant: ModelMessage = { ...message, role: 'assistant', chatReplay: { version: 1, bindingId: 'b', generation: 1,
      reasoningField: 'reasoning_content', reasoningText: 'hidden reasoning' }, providerItems: [{ type: 'reasoning', encrypted_content: 'ciphertext' }] };
    expect(JSON.stringify(summaryMessageProjection(assistant))).not.toContain('hidden reasoning');
    expect(JSON.stringify(summaryMessageProjection(assistant))).not.toContain('ciphertext');
  });
});
