import type { Message, RunEvent } from '../domain/types.js';
import type { Storage } from './storage.js';
import { id, now } from './state.js';
import { RunTextWriter } from './message-stream.js';
import type { ManagedCheckpoint } from './managed-progress.js';
import { completeRunMessage, interruptRunMessage, runMessageSources } from './run-message.js';
import type { Run } from '../domain/types.js';

/** Owns the current reply across provider output, input boundaries and checkpoints. */
export class RunReplyWriter {
  private writer: RunTextWriter;
  private key?: string;
  private prefix: string;

  constructor(
    private storage: Storage,
    private draft: Message,
    failed: (error: Error) => void,
    previousText = '',
    private changed: () => void = () => {},
  ) {
    this.writer = new RunTextWriter(storage, failed);
    const content = storage.getMessage(draft.id)?.content ?? '';
    this.prefix =
      content && previousText.endsWith(content)
        ? previousText.slice(0, -content.length)
        : previousText;
  }

  static create(
    storage: Storage,
    run: Run,
    conversationId: string,
    background: boolean,
    saved: ManagedCheckpoint | undefined,
    failed: (error: Error) => void,
    changed: () => void,
  ) {
    const draft = RunReplyWriter.initialDraft(storage, run, conversationId, background, saved);
    return new RunReplyWriter(storage, draft, failed, saved?.progress.text, changed);
  }

  private static initialDraft(
    storage: Storage,
    run: Run,
    conversationId: string,
    background: boolean,
    saved?: ManagedCheckpoint,
  ): Message {
    if (saved) {
      const previous = storage.getMessage(saved.draftId);
      if (previous && previous.status !== 'committed') {
        const resumed: Message = {
          ...previous,
          runId: run.id,
          content: saved.progress.text.slice(saved.draftPrefixLength ?? 0),
          status: 'draft',
        };
        storage.updateMessage(resumed);
        return resumed;
      }
    }
    const draft: Message = {
      id: id(),
      conversationId,
      authorType: 'bot',
      authorBotId: run.botId,
      runId: run.id,
      content: '',
      artifactIds: [],
      status: 'draft',
      createdAt: now(),
      sequence: 0,
    };
    if (saved) {
      const sources = runMessageSources(storage, run.id);
      const alreadyPublished = storage
        .messages(conversationId)
        .some(
          (message) =>
            message.sequence > saved.cutoff &&
            message.runId &&
            sources.has(message.runId) &&
            message.authorBotId === run.botId &&
            message.status === 'committed',
        );
      if (alreadyPublished) return draft;
    }
    return background ? draft : storage.appendMessage(draft);
  }

  get current(): Readonly<Message> {
    return this.draft;
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
      this.draft = this.storage.appendMessage({
        id: id(),
        conversationId: this.draft.conversationId,
        authorType: 'bot',
        authorBotId: this.draft.authorBotId,
        runId: this.draft.runId,
        content: '',
        artifactIds: [],
        status: 'draft',
        createdAt: now(),
      });
    });
  }

  beginReply(output?: string) {
    this.flush();
    this.storage.transaction(() => {
      const previous = this.storage.getMessage(this.draft.id);
      if (previous?.status === 'draft') {
        const content = this.finalText(output ?? '') || previous.content;
        if (content.trim() || previous.artifactIds.length) {
          this.storage.updateMessage({ ...previous, content, status: 'committed' });
        } else {
          this.storage.deleteMessage(previous.id);
        }
      }
      this.draft = this.storage.appendMessage({
        id: id(),
        conversationId: this.draft.conversationId,
        authorType: 'bot',
        authorBotId: this.draft.authorBotId,
        runId: this.draft.runId,
        content: '',
        artifactIds: [],
        status: 'draft',
        createdAt: now(),
      });
    });
    this.changed();
    this.prefix = '';
    this.key = undefined;
  }

  complete(output: string, artifactIds: string[]): Message {
    return completeRunMessage(this.storage, this.draft, output, artifactIds);
  }

  interrupt() {
    interruptRunMessage(this.storage, this.draft.id);
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
