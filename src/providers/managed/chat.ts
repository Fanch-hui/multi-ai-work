import type OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions';
import type { RunContext, ModelMessage } from '../../domain/provider.js';
import type { Usage } from '../../domain/types.js';
import type { Turn } from './responses.js';
import { chatInput } from './messages.js';
import { markPartialOutput } from './retry.js';
import { resolveMessageImages } from '../images.js';
import { ModelRequest } from './request.js';
import { CompletedStreamTailError, InterruptedModelStreamError, isRecoverableStreamError } from './request-errors.js';

export class ChatAccumulator {
  private text = '';
  private finishReason?: string;
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage?: Usage;
  constructor(private emit: RunContext['emit']) {}
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
    return { message: { role: 'assistant', content: this.text, toolCalls: calls }, usage: this.usage };
  }
}
export async function chatTurn(client: OpenAI, context: RunContext, messages: ModelMessage[]): Promise<Turn> {
  const request = new ModelRequest(context);
  const accumulator = new ChatAccumulator(context.emit);
  let partialOutput = false;
  try {
    const images = await resolveMessageImages({ ...context, signal: request.signal }, messages);
    request.signal.throwIfAborted();
    const stream = await client.chat.completions.create({ model: context.bot.model,
      messages: chatInput(messages, context.instructions, images), stream: true, stream_options: { include_usage: true },
      ...(context.bot.reasoning ? { reasoning_effort: context.bot.reasoning as ReasoningEffort } : {}),
      tools: context.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
    }, { signal: request.signal });
    for await (const chunk of stream) {
      if (chunk.choices.some(choice => Object.entries(choice.delta)
        .some(([key, value]) => key !== 'role' && value != null && value !== '' && (!Array.isArray(value) || value.length > 0)))) partialOutput = true;
      request.activity('chat.chunk', partialOutput);
      accumulator.accept(chunk);
      if (accumulator.finished && !accumulator.completed) accumulator.finish();
      if (accumulator.completed) {
        request.complete();
        if (accumulator.hasUsage) break;
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
