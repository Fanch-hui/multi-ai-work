import type {
  ManagedProgress,
  ManagedProgressChange,
  ModelMessage,
  RunContext,
} from '../../domain/provider.js';
import type { ModelRecovery } from '../../domain/recovery.js';
import { insertOrderedToolResult } from '../../runtime/tool-result-order.js';

export class ManagedRunState {
  private progress: Omit<ManagedProgress, 'pendingInputIds'>;
  private pendingInputIds: Set<string>;
  private turnSequence = 0;

  get messages() {
    return this.progress.messages;
  }
  /** Start of the active user turn in the current working projection. */
  get currentStart() {
    return this.progress.currentStart;
  }
  /** Start of this run's additions in the unabridged protocol archive. */
  get archiveStart() {
    return this.progress.archiveStart!;
  }
  get compaction() {
    return this.progress.compaction;
  }
  get text() {
    return this.progress.text;
  }
  get attempt() {
    return this.progress.attempt;
  }
  get earlyFailures() {
    return this.progress.earlyFailures ?? 0;
  }
  get phase() {
    return this.progress.phase;
  }

  constructor(readonly context: RunContext) {
    const saved = context.progress;
    this.pendingInputIds = new Set(saved?.pendingInputIds);
    this.progress = {
      messages: saved
        ? [...saved.messages]
        : [
            ...context.messages,
            ...(context.runtimeContext ? [context.runtimeContext] : []),
            {
              role: 'user',
              content: context.prompt,
              ...(context.images?.length ? { images: context.images } : {}),
            },
          ],
      currentStart:
        saved?.currentStart ?? context.messages.length + (context.runtimeContext ? 1 : 0),
      archiveStart: saved?.archiveStart ?? saved?.currentStart ?? context.messages.length,
      compaction: saved?.compaction,
      text: saved?.text ?? '',
      turnId: saved?.turnId ?? this.newTurnId(),
      attempt: saved?.attempt ?? 0,
      earlyFailures: saved?.earlyFailures ?? 0,
      phase: saved?.phase ?? 'ready',
    };
  }

  appendAssistant(message: ModelMessage) {
    this.progress.messages.push(message);
    this.progress.text += message.content;
  }

  updateAssistant(index: number, message: ModelMessage, precedingText: string) {
    this.progress.messages[index] = message;
    this.progress.text = precedingText + message.content;
  }

  appendMessages(messages: ModelMessage[]) {
    this.progress.messages.push(...messages);
  }

  insertToolResult(assistantIndex: number, message: ModelMessage) {
    insertOrderedToolResult(this.progress.messages, assistantIndex, message);
  }

  setAttempt(attempt: number) {
    this.progress.attempt = attempt;
  }

  resetEarlyFailures() {
    this.progress.earlyFailures = 0;
  }

  recordEarlyFailure() {
    this.progress.earlyFailures = this.earlyFailures + 1;
  }

  waitingForInput() {
    return !!(this.context.isWaitingForInput?.() || this.context.inputSignal?.aborted);
  }

  takeUserInput(): boolean {
    this.context.signal.throwIfAborted();
    if (this.waitingForInput()) return false;
    const input = this.context.userInput?.take() ?? [];
    if (!input.length) return false;
    this.context.userInput!.beginReply(this.text);
    this.progress.text = '';
    this.resetEarlyFailures();
    this.appendMessages(input);
    for (const message of input)
      if (message.sourceMessageId) this.pendingInputIds.add(message.sourceMessageId);
    this.nextTurn();
    return true;
  }

  async acknowledgeInput() {
    if (!this.pendingInputIds.size) return;
    this.context.userInput?.acknowledge?.([...this.pendingInputIds]);
    this.pendingInputIds.clear();
    await this.save(this.phase);
  }

  nextTurn() {
    this.progress.turnId = this.newTurnId();
    this.progress.attempt = 0;
    this.progress.phase = 'ready';
  }

  archiveMessages(): ModelMessage[] {
    return this.compaction
      ? [...this.compaction.archived, ...this.messages.slice(this.compaction.start)]
      : this.messages;
  }

  async applyProjection(messages: ModelMessage[], currentStart: number) {
    const archived = this.archiveMessages();
    this.progress.messages = messages;
    this.progress.currentStart = currentStart;
    // The compacted prefix is already in archived; only later additions are appended again.
    this.progress.compaction = { archived, start: messages.length };
    await this.save('ready');
  }

  async save(
    phase: ManagedProgress['phase'],
    recovery?: ModelRecovery,
    change?: ManagedProgressChange,
  ) {
    this.progress.phase = phase;
    await this.context.saveProgress?.(
      {
        ...this.progress,
        contextSignature: this.context.contextSignature,
        pendingInputIds: [...this.pendingInputIds],
        ...(recovery ? { recovery } : {}),
      },
      change,
    );
  }

  private newTurnId() {
    return `${this.context.runId}:turn:${++this.turnSequence}`;
  }
}
