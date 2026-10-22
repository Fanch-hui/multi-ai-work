import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import type { RunContext } from '../../domain/provider.js';
import { ModelActivity } from '../activity.js';
import { hasOutputText, markModelWorkStarted } from '../first-output.js';

export class QoderEvents {
  text = '';
  private streamedMessage = false;
  private messageSequence = 0;
  private messageStarted = false;
  private activity: ModelActivity;
  private nativeCalls = new Map<string, string>();
  constructor(private context: RunContext) {
    this.activity = new ModelActivity((event) => context.emit(event));
  }
  beginReply(): void {
    this.text = '';
    this.streamedMessage = false;
    this.messageStarted = false;
    this.activity.reset();
  }
  accept(message: SDKMessage): void {
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      if (message.event.type === 'message_start') {
        this.messageSequence++;
        this.messageStarted = true;
        this.streamedMessage = false;
        this.activity.report('waiting', 'message_start');
      }
      const delta = message.event.delta as
        | { type?: string; text?: string; thinking?: string; partial_json?: string }
        | undefined;
      if (
        message.event.type === 'content_block_delta' &&
        ((delta?.type === 'thinking_delta' && hasOutputText(delta.thinking)) ||
          (delta?.type === 'input_json_delta' && hasOutputText(delta.partial_json)))
      )
        markModelWorkStarted(this.context);
      if (message.event.type === 'content_block_delta' && delta?.type === 'thinking_delta')
        this.activity.report('thinking', 'thinking_delta');
      if (message.event.type === 'content_block_delta' && delta?.type === 'input_json_delta')
        this.activity.report('tool', 'input_json_delta');
      if (
        message.event.type === 'content_block_delta' &&
        delta?.type === 'text_delta' &&
        typeof delta.text === 'string'
      ) {
        this.streamedMessage = true;
        this.append(delta.text);
      }
      if (
        message.event.type === 'content_block_start' &&
        message.event.content_block?.type === 'tool_use'
      ) {
        const tool = message.event.content_block;
        if (hasOutputText(tool.name)) markModelWorkStarted(this.context);
        this.activity.report('tool', 'tool_use');
        if (
          tool.id &&
          tool.name &&
          !tool.name.startsWith('mcp__ai-team__') &&
          !this.context.nativeTools?.names.includes(tool.name)
        ) {
          this.nativeCalls.set(tool.id, tool.name);
          this.context.emit({
            type: 'tool',
            data: { source: 'native', callId: tool.id, name: tool.name, status: 'running' },
          });
        }
      }
    }
    if (message.type === 'user' && !message.parent_tool_use_id) this.completeNativeCalls(message);
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      if (message.error)
        throw new Error(
          message.error === 'authentication_failed' ? 'Qoder 需要重新登录' : 'Qoder 模型请求失败',
        );
      if (!this.messageStarted) this.messageSequence++;
      for (const block of message.message.content) {
        if (
          (block.type === 'tool_use' && hasOutputText(block.name)) ||
          (block.type === 'thinking' && hasOutputText(block.thinking))
        )
          markModelWorkStarted(this.context);
      }
      if (!this.streamedMessage)
        for (const block of message.message.content)
          if (block.type === 'text' && typeof block.text === 'string') this.append(block.text);
      this.streamedMessage = false;
      this.messageStarted = false;
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary')
      this.context.emit({
        type: 'compaction',
        data: {
          owner: 'native',
          trigger: message.compact_metadata.trigger,
          previousTokens: message.compact_metadata.pre_tokens,
        },
      });
    if (message.type === 'system' && message.subtype === 'status')
      this.context.emit({ type: 'status', data: { phase: message.status } });
  }

  private completeNativeCalls(message: Extract<SDKMessage, { type: 'user' }>): void {
    if (!Array.isArray(message.message.content)) return;
    for (const block of message.message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const name = this.nativeCalls.get(block.tool_use_id);
      if (!name) continue;
      this.nativeCalls.delete(block.tool_use_id);
      const notExecuted = message.tool_result_meta?.some((meta) => meta.id === block.tool_use_id);
      this.context.emit({
        type: 'tool',
        data: {
          source: 'native',
          callId: block.tool_use_id,
          name,
          status: block.is_error || notExecuted ? 'failed' : 'completed',
        },
      });
    }
  }

  private append(delta: string): void {
    if (hasOutputText(delta)) markModelWorkStarted(this.context);
    if (delta) this.activity.report('responding', 'text_delta');
    this.text += delta;
    this.context.emit({
      type: 'text',
      data: { delta, messageKey: `qoder:${this.messageSequence}` },
    });
  }
}
