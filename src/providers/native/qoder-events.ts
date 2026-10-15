import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import type { RunContext } from '../../domain/provider.js';

export class QoderEvents {
  text = '';
  private streamedMessage = false;
  constructor(private context: RunContext) {}
  beginReply(): void { this.text = ''; this.streamedMessage = false; }
  accept(message: SDKMessage): void {
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      if (message.event.type === 'message_start') this.streamedMessage = false;
      const delta = message.event.delta as { type?: string; text?: string } | undefined;
      if (message.event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.streamedMessage = true; this.append(delta.text);
      }
      if (message.event.type === 'content_block_start' && message.event.content_block?.type === 'tool_use') {
        const tool = message.event.content_block;
        if (tool.name && !tool.name.startsWith('mcp__ai-team__') && !this.context.nativeTools?.names.includes(tool.name))
          this.context.emit({ type: 'tool', data: { source: 'native', callId: tool.id, name: tool.name, status: 'running' } });
      }
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      if (message.error) throw new Error(message.error === 'authentication_failed' ? 'Qoder 需要重新登录' : 'Qoder 模型请求失败');
      if (!this.streamedMessage) for (const block of message.message.content) if (block.type === 'text' && typeof block.text === 'string') this.append(block.text);
      this.streamedMessage = false;
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary')
      this.context.emit({ type: 'compaction', data: { owner: 'native', trigger: message.compact_metadata.trigger,
        previousTokens: message.compact_metadata.pre_tokens } });
    if (message.type === 'system' && message.subtype === 'status')
      this.context.emit({ type: 'status', data: { phase: message.status } });
  }
  private append(delta: string): void { this.text += delta; this.context.emit({ type: 'text', data: { delta } }); }
}
