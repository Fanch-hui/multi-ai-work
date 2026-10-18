import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import type { ModelMessage, RunContext } from '../../domain/provider.js';
import { toolResultMessage } from '../images.js';
import { parseToolArguments } from './messages.js';
import type { ManagedRunState } from './progress.js';

export class ConfirmedToolStreamError extends Error {
  readonly code = 'MODEL_CONFIRMED_TOOLS';
  constructor(readonly streamError: unknown) { super('模型流中断，保留已确认的工具调用', { cause: streamError }); }
}

export class EarlyResponseTools {
  private items = new Map<number, ResponseOutputItem>();
  private prefix = 0;
  private blocked = false;
  private stopped = false;
  private scheduled = new Set<string>();
  private queued: NonNullable<ModelMessage['toolCalls']> = [];
  private running = new Set<Promise<void>>();
  private saving = Promise.resolve();
  private failure?: { error: unknown };
  private originalText: string;
  private previousCalls: Set<string>;
  assistantIndex?: number;

  constructor(private context: RunContext, private state: ManagedRunState) {
    this.originalText = state.text;
    this.previousCalls = new Set(state.archiveMessages().flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
  }

  async accept(index: number, item: ResponseOutputItem) {
    if (!Number.isSafeInteger(index) || index < 0 || this.stopped) return;
    const previous = this.items.get(index);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('模型修改已完成的输出条目');
    this.items.set(index, structuredClone(item));
    while (this.items.has(this.prefix)) this.prefix++;
    const output = Array.from({ length: this.prefix }, (_, position) => this.items.get(position)!);
    const calls = output.filter(entry => entry.type === 'function_call');
    if (this.assistantIndex === undefined && !this.canStart(calls)) return;
    await this.serialize(async () => {
      const message = this.message(output);
      this.state.text = this.originalText + message.content;
      if (this.assistantIndex === undefined) {
        this.assistantIndex = this.state.messages.length;
        this.state.messages.push(message);
        await this.state.save('tools');
      } else {
        this.state.messages[this.assistantIndex] = message;
        await this.state.save('tools', undefined, { type: 'assistant-item', assistantIndex: this.assistantIndex });
      }
    });
    for (const call of calls) {
      if (this.scheduled.has(call.call_id)) continue;
      if (!this.valid(call)) { this.blocked = true; break; }
      if (this.blocked || !this.context.parallelToolNames?.includes(call.name)) { this.blocked = true; break; }
      this.scheduled.add(call.call_id);
      this.queued.push({ id: call.call_id, name: call.name, arguments: call.arguments });
    }
    this.pump();
  }

  stop() { this.stopped = true; }

  async finish(message?: ModelMessage) {
    this.stop();
    const started = performance.now();
    const active = this.running.size;
    await Promise.all(this.running);
    if (active) this.context.emit({ type: 'status', data: { phase: 'performance', stage: 'tool-early-wait',
      durationMs: performance.now() - started, calls: active } });
    await this.saving;
    if (this.failure) throw this.failure.error;
    if (this.assistantIndex === undefined) return false;
    if (message) {
      const confirmed = this.state.messages[this.assistantIndex].toolCalls ?? [];
      for (const call of confirmed) {
        const terminal = message.toolCalls?.find(entry => entry.id === call.id);
        if (!terminal || JSON.stringify(terminal) !== JSON.stringify(call)) throw new Error('模型终态修改已确认工具调用，需要对账');
      }
      this.state.messages[this.assistantIndex] = message;
    }
    this.state.text = this.originalText + this.state.messages[this.assistantIndex].content;
    await this.state.save('tools', undefined, { type: 'assistant-item', assistantIndex: this.assistantIndex });
    return true;
  }

  private canStart(calls: Extract<ResponseOutputItem, { type: 'function_call' }>[]) {
    const first = calls[0];
    return first && this.valid(first) && this.context.parallelToolNames?.includes(first.name);
  }

  private valid(call: Extract<ResponseOutputItem, { type: 'function_call' }>) {
    if (call.status !== 'completed' || !call.id || !call.call_id || !call.name || typeof call.arguments !== 'string'
      || !this.context.tools.some(tool => tool.name === call.name)) return false;
    try { parseToolArguments(call.arguments); return true; } catch { return false; }
  }

  private message(output: ResponseOutputItem[]): ModelMessage {
    const calls = output.filter(item => item.type === 'function_call');
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.call_id || ids.has(call.call_id) || this.previousCalls.has(call.call_id)) throw new Error('模型重复提交工具调用，需要对账');
      ids.add(call.call_id);
    }
    return { role: 'assistant', content: output.filter(item => item.type === 'message').flatMap(item => item.content)
      .map(part => part.type === 'output_text' ? part.text : '').join(''), providerItems: output,
      toolCalls: calls.map(call => ({ id: call.call_id, name: call.name, arguments: call.arguments })) };
  }

  private serialize(action: () => Promise<void>) {
    const saved = this.saving.then(action);
    this.saving = saved.catch(error => { this.failure ??= { error }; this.stopped = true; });
    return saved;
  }

  private pump() {
    while (!this.stopped && !this.failure && this.running.size < 4 && this.queued.length) {
      if (this.context.signal.aborted || this.context.userInput?.hasPending() || this.state.waitingForInput()) { this.stopped = true; break; }
      const call = this.queued.shift()!;
      const job = (async () => {
        this.context.emit({ type: 'tool', data: { name: call.name, callId: call.id, phase: 'started' } });
        const result = await this.context.executeTool(call.name, parseToolArguments(call.arguments), call.id);
        await this.serialize(async () => {
          const calls = this.state.messages[this.assistantIndex!].toolCalls!;
          const order = new Map(calls.map((entry, index) => [entry.id, index]));
          const index = this.state.messages.findIndex((message, index) => index > this.assistantIndex! && message.role === 'tool'
            && order.get(message.callId!)! > order.get(call.id)!);
          this.state.messages.splice(index < 0 ? this.state.messages.length : index, 0, toolResultMessage(call.id, result));
          await this.state.save('tools', undefined, { type: 'tool-result', assistantIndex: this.assistantIndex!, callId: call.id });
          this.context.emit({ type: 'tool', data: { name: call.name, callId: call.id, phase: 'completed' } });
        });
      })().catch(error => { this.failure ??= { error }; this.stopped = true; });
      this.running.add(job);
      void job.finally(() => { this.running.delete(job); this.pump(); });
    }
  }
}
