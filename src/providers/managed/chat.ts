import type OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions';
import type { RunContext, ModelMessage } from '../../domain/provider.js';
import type { Usage } from '../../domain/types.js';
import type { ModelActivityKind } from '../../domain/task-activity.js';
import type { Turn } from './responses.js';
import { chatInput } from './messages.js';
import { markPartialOutput } from './retry.js';
import { resolveMessageImages } from '../images.js';
import { ModelRequest } from './request.js';
import { CompletedStreamTailError, InterruptedModelStreamError, isRecoverableStreamError } from './request-errors.js';
import { ChatReplayAccumulator } from './chat-replay.js';
import type { ChatReplayCompatibility } from './chat-replay-compatibility.js';

export class ChatAccumulator {
  private text = '';
  private finishReason?: string;
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage?: Usage;
  private replay = new ChatReplayAccumulator();
  constructor(private emit: RunContext['emit'], private bindingId?: string, private generation?: number) {}
  get finished() { return this.finishReason !== undefined; }
  get completed() { return ['stop', 'tool_calls'].includes(this.finishReason ?? ''); }
  get hasUsage() { return this.usage !== undefined; }
  accept(chunk: ChatCompletionChunk): void {
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
      this.usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, source: 'reported',
        ...(cached === undefined ? {} : { cachedInputTokens: cached }) };
    }
    const choice = chunk.choices.find(item => item.index === 0);
    if (!choice) return;
    this.replay.accept(choice.delta);
    if (choice.delta.content) { this.text += choice.delta.content; this.emit({ type: 'text', data: { delta: choice.delta.content } }); }
    for (const fragment of choice.delta.tool_calls ?? []) {
      const call = this.calls.get(fragment.index) ?? { id: '', name: '', arguments: '' };
      call.id += fragment.id ?? ''; call.name += fragment.function?.name ?? ''; call.arguments += fragment.function?.arguments ?? '';
      this.calls.set(fragment.index, call);
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }
  finish(): Turn {
    if (!this.finishReason) throw new InterruptedModelStreamError('模型响应未完成：流中断');
    if (!this.completed) throw new Error(`模型响应未完成：${this.finishReason}`);
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (this.finishReason === 'stop' && calls.length) throw new Error('模型工具调用终态不一致');
    if (calls.some(call => !call.id || !call.name) || (this.finishReason === 'tool_calls' && !calls.length)) throw new Error('模型工具调用不完整');
    const chatReplay = this.replay.finish(this.bindingId, this.generation);
    return { message: { role: 'assistant', content: this.text, toolCalls: calls, ...(chatReplay ? { chatReplay } : {}) }, usage: this.usage };
  }
}

function chunkActivity(chunk: ChatCompletionChunk): ModelActivityKind | undefined {
  const delta = chunk.choices.find(choice => choice.index === 0)?.delta;
  if (!delta) return undefined;
  if (delta.tool_calls?.length || delta.function_call) return 'tool';
  if (delta.content || delta.refusal) return 'responding';
  const fields = delta as Record<string, unknown>;
  if (['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details'].some(key => fields[key]
    && (!Array.isArray(fields[key]) || fields[key].length))) return 'thinking';
  if (Object.entries(fields).some(([key, value]) => key !== 'role' && value != null && value !== ''
    && (!Array.isArray(value) || value.length))) return 'working';
  return delta.role ? 'waiting' : undefined;
}
export async function chatTurn(client: OpenAI, context: RunContext, messages: ModelMessage[], requestId?: string, compatibility?: ChatReplayCompatibility): Promise<Turn> {
  const request = new ModelRequest(context, requestId);
  const accumulator = new ChatAccumulator(context.emit, context.binding.id, context.binding.generation);
  let partialOutput = false;
  let callsReady = false;
  try {
    const images = await resolveMessageImages({ ...context, signal: request.signal }, messages);
    request.signal.throwIfAborted();
    const stream = await client.chat.completions.create({ model: context.bot.model,
      messages: chatInput(messages, context.instructions, images, { bindingId: context.binding.id, generation: context.binding.generation,
        rejectedFields: compatibility?.fields(context) }),
      stream: true, stream_options: { include_usage: true },
      ...(context.bot.reasoning ? { reasoning_effort: context.bot.reasoning as ReasoningEffort } : {}),
      tools: context.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    }, { signal: request.signal });
    for await (const chunk of stream) {
      if (chunk.choices.some(choice => Object.entries(choice.delta)
        .some(([key, value]) => key !== 'role' && value != null && value !== '' && (!Array.isArray(value) || value.length > 0)))) partialOutput = true;
      request.activity('chat.chunk', partialOutput, chunkActivity(chunk));
      accumulator.accept(chunk);
      if (accumulator.finished && !accumulator.completed) accumulator.finish();
      if (accumulator.completed) {
        if (!callsReady) {
          for (const call of accumulator.finish().message.toolCalls ?? []) request.toolReady(call.name, call.id);
          callsReady = true;
        }
        if (accumulator.hasUsage) break;
        request.complete();
      }
    }
    request.signal.throwIfAborted();
    return accumulator.finish();
  } catch (error) {
    const failure = request.error(error);
    context.signal.throwIfAborted();
    if (accumulator.completed && (failure instanceof CompletedStreamTailError || isRecoverableStreamError(failure))) return accumulator.finish();
    throw markPartialOutput(failure, partialOutput);
  }
  finally { request.close(); }
}
