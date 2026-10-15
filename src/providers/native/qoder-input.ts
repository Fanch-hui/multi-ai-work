import { randomUUID } from 'node:crypto';
import type { SDKMessage, SDKUserMessage } from '@qodercn-ai/qodercn-agent-sdk';
import type { RunContext } from '../../domain/provider.js';
import { qoderImageContent } from '../images.js';
import { NativeInput } from './input.js';
import type { QoderEvents } from './qoder-events.js';

/** Native input echoes and the following assistant message establish a reply boundary. */
export class QoderInput {
  readonly failure: Promise<never>;
  private fail!: (error: unknown) => void;
  private pending = new Map<string, string | undefined>();
  private sending: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private stopped = false;
  private awaitingReply = false;

  constructor(private context: RunContext, private input: NativeInput<SDKUserMessage>,
    private sessionId: string, private events: QoderEvents) {
    this.failure = new Promise((_, reject) => { this.fail = reject; });
    void this.failure.catch(() => {});
  }

  start(): void {
    this.unsubscribe = this.context.userInput?.subscribe(() => this.schedule());
    this.schedule();
  }

  accept(message: SDKMessage): void {
    if (message.type === 'user' && message.uuid && this.pending.has(message.uuid)) {
      const messageId = this.pending.get(message.uuid);
      this.pending.delete(message.uuid);
      if (messageId) this.context.userInput?.acknowledge?.([messageId]);
      this.awaitingReply = true;
    }
    const responseStarted = message.type === 'assistant' && !message.parent_tool_use_id
      || message.type === 'stream_event' && !message.parent_tool_use_id && message.event.type === 'message_start';
    if (!this.awaitingReply || !responseStarted) return;
    this.awaitingReply = false;
    this.context.userInput!.beginReply(this.events.text);
    this.events.beginReply();
  }

  async flush(): Promise<void> {
    await this.sending;
    if (this.context.userInput?.hasPending()) {
      this.schedule();
      await this.sending;
    }
  }

  hasOutstanding(): boolean { return this.pending.size > 0 || this.awaitingReply; }

  stop(): void { this.stopped = true; this.unsubscribe?.(); }

  private schedule(): void {
    if (this.stopped || this.context.isWaitingForInput?.() || this.context.inputSignal?.aborted) return;
    this.sending = this.sending.then(async () => {
      if (this.stopped || this.context.isWaitingForInput?.() || this.context.inputSignal?.aborted) return;
      for (const message of this.context.userInput?.take() ?? []) {
        this.context.signal.throwIfAborted();
        const content = await qoderImageContent({ ...this.context, prompt: message.content, images: message.images });
        this.context.signal.throwIfAborted();
        if (this.stopped || this.context.isWaitingForInput?.() || this.context.inputSignal?.aborted) return;
        const uuid = randomUUID();
        this.pending.set(uuid, message.sourceMessageId);
        this.input.send({ type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null,
          priority: 'next', message: { role: 'user', content } });
      }
    });
    void this.sending.catch(error => this.fail(error));
  }
}
