import type {
  ChatReasoningDetail,
  ChatReasoningField,
  ChatReplay,
  ModelMessage,
} from '../../domain/provider.js';

const reasoningFields: readonly ChatReasoningField[] = [
  'reasoning_content',
  'reasoning',
  'reasoning_text',
];
export type ChatReplayField = ChatReasoningField | 'reasoning_details';
export interface ChatReplayOptions {
  bindingId?: string;
  generation?: number;
  rejectedFields?: ReadonlySet<ChatReplayField>;
}

function detail(value: unknown): ChatReasoningDetail | undefined {
  if (!value || typeof value !== 'object') return;
  const source = value as Record<string, unknown>;
  let field: string | undefined;
  if (source.type === 'reasoning.text') field = 'text';
  else if (source.type === 'reasoning.summary') field = 'summary';
  else if (source.type === 'reasoning.encrypted') field = 'data';
  if (!field || typeof source[field] !== 'string') return;
  return structuredClone(source) as ChatReasoningDetail;
}

function compatible(previous: ChatReasoningDetail, next: ChatReasoningDetail): boolean {
  if (previous.type !== next.type || next.type === 'reasoning.encrypted') return false;
  const content = next.type === 'reasoning.text' ? 'text' : 'summary';
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].every(
    (key) =>
      key === content ||
      previous[key] == null ||
      next[key] == null ||
      JSON.stringify(previous[key]) === JSON.stringify(next[key]),
  );
}

export class ChatReplayAccumulator {
  private field?: ChatReasoningField;
  private text = '';
  private details: ChatReasoningDetail[] = [];
  accept(delta: unknown): void {
    if (!delta || typeof delta !== 'object') return;
    const source = delta as Record<string, unknown>;
    const field =
      this.field ??
      reasoningFields.find((key) => typeof source[key] === 'string' && source[key] !== '');
    if (field && typeof source[field] === 'string') {
      this.field = field;
      this.text += source[field];
    }
    if (!Array.isArray(source.reasoning_details)) return;
    for (const value of source.reasoning_details) {
      const next = detail(value);
      if (!next) continue;
      const previous = this.details.at(-1);
      if (!previous || !compatible(previous, next)) {
        this.details.push(next);
        continue;
      }
      if (previous.type === 'reasoning.text' && next.type === 'reasoning.text')
        next.text = previous.text + next.text;
      if (previous.type === 'reasoning.summary' && next.type === 'reasoning.summary')
        next.summary = previous.summary + next.summary;
      this.details[this.details.length - 1] = {
        ...previous,
        ...Object.fromEntries(
          Object.entries(next).filter(([key, value]) => value != null || previous[key] == null),
        ),
      } as ChatReasoningDetail;
    }
  }
  finish(bindingId?: string, generation?: number): ChatReplay | undefined {
    if (!bindingId || generation === undefined || (!this.text && !this.details.length)) return;
    return {
      version: 1,
      bindingId,
      generation,
      ...(this.text ? { reasoningField: this.field, reasoningText: this.text } : {}),
      ...(this.details.length ? { reasoningDetails: structuredClone(this.details) } : {}),
    };
  }
}

export function chatReplayFields(
  message: ModelMessage,
  options?: ChatReplayOptions,
): Partial<Record<ChatReplayField, unknown>> {
  const replay = message.chatReplay;
  if (
    message.role !== 'assistant' ||
    !options?.bindingId ||
    options.generation === undefined ||
    replay?.version !== 1 ||
    replay.bindingId !== options.bindingId ||
    replay.generation !== options.generation
  )
    return {};
  if (replay.reasoningDetails?.length)
    return options.rejectedFields?.has('reasoning_details')
      ? {}
      : { reasoning_details: structuredClone(replay.reasoningDetails) };
  if (
    replay.reasoningField &&
    reasoningFields.includes(replay.reasoningField) &&
    replay.reasoningText &&
    !options.rejectedFields?.has(replay.reasoningField)
  )
    return { [replay.reasoningField]: replay.reasoningText };
  return {};
}
