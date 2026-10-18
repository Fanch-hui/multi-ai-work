import type OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { Response, ResponseCreateParamsStreaming, ResponseOutputItem, ResponseOutputMessage, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { ModelMessage, RunContext } from '../../domain/provider.js';
import type { Usage } from '../../domain/types.js';
import type { ModelActivityKind } from '../../domain/task-activity.js';
import { responsesInput } from './messages.js';
import { markPartialOutput } from './retry.js';
import { resolveMessageImages } from '../images.js';
import { ModelRequest } from './request.js';
import { InterruptedModelStreamError } from './request-errors.js';
import type { createResponsesTransport } from './responses-transport.js';
import type { ResponsesCacheDiagnostics } from './cache-diagnostics.js';

export interface Turn { message: ModelMessage; usage?: Usage; persisted?: boolean; }

function responseActivity(event: ResponseStreamEvent): ModelActivityKind {
  if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.queued') return 'waiting';
  if (event.type.startsWith('response.reasoning_')) return 'thinking';
  if (event.type.startsWith('response.function_call_arguments.')) return 'tool';
  if (event.type.startsWith('response.output_text.') || event.type.startsWith('response.refusal.')) return 'responding';
  if ('item' in event) {
    if (event.item.type === 'reasoning') return 'thinking';
    if (event.item.type === 'function_call') return 'tool';
  }
  return 'working';
}
export class ResponsesAccumulator {
  private completed?: Response;
  private items = new Map<number, ResponseOutputItem>();
  private doneItems = new Set<number>();
  private streamed = new Set<string>();
  constructor(private emit: RunContext['emit'], private messagePrefix?: string) {}
  accept(event: ResponseStreamEvent): void {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      this.items.set(event.output_index, structuredClone(event.item));
      if (event.type === 'response.output_item.done') {
        this.doneItems.add(event.output_index);
        if (event.item.type === 'message') this.emitMessage(event.item);
      }
    }
    if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') {
      if (event.part.type !== 'reasoning_text') this.message(event.output_index, event.item_id).content[event.content_index] = structuredClone(event.part);
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      if (Number.isSafeInteger(event.output_index) && Number.isSafeInteger(event.content_index) && event.item_id) {
        const message = this.message(event.output_index, event.item_id);
        const part = message.content[event.content_index];
        const text = event.type === 'response.output_text.done' ? event.text : (part?.type === 'output_text' ? part.text : '') + event.delta;
        message.content[event.content_index] = { ...(part?.type === 'output_text' ? part : {}), type: 'output_text', text, annotations: part?.type === 'output_text' ? part.annotations : [] };
      }
      if (event.type === 'response.output_text.delta') {
        this.streamed.add(event.item_id);
        this.emit({ type: 'text', data: { delta: event.delta,
          ...(this.messagePrefix ? { messageKey: `${this.messagePrefix}:${event.item_id}` } : {}) } });
      }
    }
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      const code = event.type === 'response.failed' ? event.response.error?.code ?? 'failed' : event.response.incomplete_details?.reason ?? 'incomplete';
      throw Object.assign(new Error(`模型响应未完成：${code}`), event.type === 'response.failed' ? { code } : {});
    }
    if (event.type === 'error') throw Object.assign(new Error('模型返回错误事件'), { code: event.code });
    if (event.type === 'response.completed') {
      if (event.response.status !== 'completed') throw new Error('模型终态无效');
      this.completed = event.response;
    }
  }
  finish(): Turn {
    if (!this.completed) throw new InterruptedModelStreamError('模型流已中断，缺少 response.completed');
    const output = this.output();
    if (output.some(item => (item.type === 'message' || item.type === 'function_call') && item.status === 'incomplete')) {
      throw new Error('模型输出条目未完成');
    }
    const messages = output.filter(item => item.type === 'message');
    let refused = false;
    for (const message of messages) {
      this.emitMessage(message);
      const refusal = message.content.filter(part => part.type === 'refusal').map(part => part.refusal).join('');
      if (!refusal) continue;
      refused = true;
      this.emit({ type: 'text', data: { delta: refusal,
        ...(this.messagePrefix ? { messageKey: `${this.messagePrefix}:${message.id}` } : {}) } });
    }
    if (refused) throw new Error('模型拒绝执行该请求');
    const calls = output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
    const text = output.filter(item => item.type === 'message').flatMap(item => item.content)
      .map(content => content.type === 'output_text' ? content.text : content.type === 'refusal' ? content.refusal : '').join('');
    const usage = this.completed.usage;
    const cached = usage?.input_tokens_details?.cached_tokens;
    return { message: { role: 'assistant', content: text, toolCalls: calls, providerItems: output },
      usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, source: 'reported',
        ...(cached === undefined ? {} : { cachedInputTokens: cached }) } : undefined };
  }
  private emitMessage(item: ResponseOutputMessage) {
    if (this.streamed.has(item.id)) return;
    const text = item.content.map(part => part.type === 'output_text' ? part.text : '').join('');
    if (!text) return;
    this.streamed.add(item.id);
    this.emit({ type: 'text', data: { delta: text,
      ...(this.messagePrefix ? { messageKey: `${this.messagePrefix}:${item.id}` } : {}) } });
  }
  private message(index: number, id: string): ResponseOutputMessage {
    const existing = this.items.get(index);
    if (existing?.type === 'message') return existing;
    const item: ResponseOutputMessage = { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] };
    this.items.set(index, item);
    return item;
  }
  private output(): ResponseOutputItem[] {
    // Some streams send complete items before a terminal response with an empty output.
    // Keep the event projection for both the visible answer and subsequent history.
    const terminal = this.completed!.output;
    if (terminal.length) return terminal.map(item => {
      if (item.type !== 'message') return item;
      const streamed = [...this.items.values()].find(candidate => candidate.type === 'message' && candidate.id === item.id);
      if (streamed?.type !== 'message') return item;
      const content = item.content.length ? item.content.map((part, index) => {
        const previous = streamed.content[index];
        return part.type === 'output_text' && !part.text && previous?.type === 'output_text' ? { ...part, text: previous.text } : part;
      }) : streamed.content;
      return { ...streamed, ...item, content };
    });
    return [...this.items.entries()].sort(([a], [b]) => a - b).map(([index, item]): ResponseOutputItem => {
      if (item.type === 'message') return { ...item, status: item.status === 'incomplete' ? 'incomplete' : 'completed' };
      if (this.doneItems.has(index)) return item;
      throw new Error('模型输出条目缺少完成事件');
    });
  }
}
export async function responsesTurn(client: OpenAI, context: RunContext, messages: ModelMessage[],
  diagnostics?: ResponsesCacheDiagnostics, requestId = context.runId,
  onItem?: (index: number, item: ResponseOutputItem) => Promise<void>,
  transport?: ReturnType<typeof createResponsesTransport>): Promise<Turn> {
  const request = new ModelRequest(context, requestId);
  let partialOutput = false;
  try {
    const images = await resolveMessageImages({ ...context, signal: request.signal }, messages);
    request.signal.throwIfAborted();
    const body: ResponseCreateParamsStreaming = {
      model: context.bot.model, instructions: context.instructions, input: responsesInput(messages, images), store: false, stream: true,
      include: ['reasoning.encrypted_content'],
      ...(context.bot.reasoning ? { reasoning: { effort: context.bot.reasoning as ReasoningEffort } } : {}),
      tools: context.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
    };
    const trace = diagnostics?.begin(context, requestId, body);
    const payload = { ...body, ...trace?.options };
    const stream = transport ? await transport.stream(payload, request.signal)
      : await client.responses.create(payload, { signal: request.signal });
    const accumulator = new ResponsesAccumulator(context.emit, requestId);
    let completed: Response | undefined;
    for await (const event of stream) {
      if (event.type.startsWith('response.output_') || event.type.startsWith('response.content_part.')
        || event.type.startsWith('response.function_call_arguments.') || event.type.startsWith('response.reasoning_')
        || ('response' in event && event.response.output.length > 0)) partialOutput = true;
      request.activity(event.type, partialOutput, responseActivity(event));
      accumulator.accept(event);
      if (event.type === 'response.output_item.done') {
        if (event.item.type === 'function_call') request.toolReady(event.item.name, event.item.call_id);
        await onItem?.(event.output_index, event.item);
      }
      if (event.type === 'response.completed') { completed = event.response; break; }
    }
    request.signal.throwIfAborted();
    const turn = accumulator.finish();
    for (const call of turn.message.toolCalls ?? []) request.toolReady(call.name, call.id);
    if (completed) trace?.complete(completed);
    return turn;
  } catch (error) { throw markPartialOutput(request.error(error), partialOutput); }
  finally { request.close(); }
}
