import type { Message, RunEvent } from '../domain/types.js';
import type { Storage } from './storage.js';
import { id, now } from './state.js';
import { RunTextWriter } from './message-stream.js';

/** Provider message boundaries share one mutable draft with checkpoints and task input. */
export class RunReplyWriter {
  private writer: RunTextWriter;
  private key?: string;
  private prefix: string;

  constructor(
    private storage: Storage,
    private draft: Message,
    failed: (error: Error) => void,
    previousText = '',
  ) {
    this.writer = new RunTextWriter(storage, failed);
    const content = storage.getMessage(draft.id)?.content ?? '';
    this.prefix =
      content && previousText.endsWith(content)
        ? previousText.slice(0, -content.length)
        : previousText;
  }

  append(event: RunEvent) {
    const key = typeof event.data.messageKey === 'string' ? event.data.messageKey : undefined;
    if (key && this.key && key !== this.key) this.next();
    if (key) this.key = key;
    if (this.storage.getMessage(this.draft.id)?.status !== 'draft') this.next();
    const replace = event.data.replace;
    const recorded =
      typeof replace === 'string' && !key && replace.startsWith(this.prefix)
        ? { ...event, data: { ...event.data, replace: replace.slice(this.prefix.length) } }
        : event;
    this.writer.append(recorded, this.draft.id);
  }

  next() {
    this.flush();
    this.storage.transaction(() => {
      const current = this.storage.getMessage(this.draft.id);
      if (current?.status === 'draft' && !current.content.trim() && !current.artifactIds.length)
        return;
      if (current) {
        if (current.status === 'draft')
          this.storage.updateMessage({ ...current, status: 'committed' });
        this.prefix += current.content;
      }
      Object.assign(
        this.draft,
        this.storage.appendMessage({
          id: id(),
          conversationId: this.draft.conversationId,
          authorType: 'bot',
          authorBotId: this.draft.authorBotId,
          runId: this.draft.runId,
          content: '',
          artifactIds: [],
          status: 'draft',
          createdAt: now(),
        }),
      );
    });
  }

  beginReply() {
    this.prefix = '';
    this.key = undefined;
  }
  get prefixLength() {
    return this.prefix.length;
  }

  finalText(output: string) {
    const current = this.storage.getMessage(this.draft.id)?.content ?? '';
    if (this.prefix && output.startsWith(this.prefix)) return output.slice(this.prefix.length);
    return output || current;
  }

  check() {
    this.writer.check();
  }
  flush() {
    this.writer.flush();
  }
  close() {
    this.writer.close();
  }
}
