import type { ModelMessage } from '../../domain/provider.js';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions';
import { imageUrl } from '../images.js';
import { modelMessageContent } from '../../runtime/image-references.js';
import { chatReplayFields, type ChatReplayOptions } from './chat-replay.js';

function serializeToolArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return '{}';
  }
}

export function responsesInput(
  messages: ModelMessage[],
  images = new Map<string, string>(),
  includeReasoningUpdates = false,
): ResponseInput {
  return messages.flatMap((message) => {
    if (message.reasoningUpdate) {
      return includeReasoningUpdates
        ? [{ type: 'configuration_update', reasoning: { effort: message.reasoningUpdate.effort } }]
        : [];
    }
    if (message.providerItems?.length)
      return message.providerItems.filter(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          (item as { type?: unknown }).type !== 'configuration_update',
      );
    const text = modelMessageContent(message);
    const content = message.images?.length
      ? [
          ...(text ? [{ type: 'input_text', text }] : []),
          ...message.images.map((image) => ({
            type: 'input_image',
            image_url: imageUrl(image, images),
            detail: 'auto',
          })),
        ]
      : text;
    if (message.role === 'tool')
      return [{ type: 'function_call_output', call_id: message.callId, output: content }];
    const items: unknown[] =
      text || message.images?.length ? [{ role: message.role, content }] : [];
    for (const call of message.toolCalls ?? [])
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: serializeToolArguments(call.arguments),
      });
    return items;
  }) as ResponseInput;
}
export function chatInput(
  messages: ModelMessage[],
  instructions: string,
  images = new Map<string, string>(),
  replay?: ChatReplayOptions,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: 'system', content: instructions }];
  let toolImages: NonNullable<ModelMessage['images']> = [];
  const flushImages = () => {
    if (toolImages.length)
      result.push({
        role: 'user',
        content: [
          { type: 'text', text: '以下图片来自前述工具返回。' },
          ...toolImages.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: imageUrl(image, images) },
          })),
        ],
      });
    toolImages = [];
  };
  for (const message of messages) {
    if (message.reasoningUpdate) continue;
    const text = modelMessageContent(message);
    if (message.role !== 'tool') flushImages();
    if (message.role === 'tool') {
      result.push({ role: 'tool', tool_call_id: message.callId!, content: text });
      toolImages.push(...(message.images ?? []));
    } else if (message.role === 'user')
      result.push({
        role: 'user',
        content: message.images?.length
          ? [
              ...(text ? [{ type: 'text' as const, text }] : []),
              ...message.images.map((image) => ({
                type: 'image_url' as const,
                image_url: { url: imageUrl(image, images) },
              })),
            ]
          : text,
      });
    else
      result.push({
        role: 'assistant',
        content: text || null,
        ...chatReplayFields(message, replay),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: serializeToolArguments(call.arguments) },
              })),
            }
          : {}),
      });
  }
  flushImages();
  return result;
}
export function parseToolArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('工具参数 JSON 格式无效');
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error('工具参数必须是 JSON 对象');
  return value as Record<string, unknown>;
}
