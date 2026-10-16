import type { ManagedProgress, ModelMessage, RunContext } from '../../domain/provider.js';
import type { ModelRecovery } from '../../domain/recovery.js';

export class ManagedRunState {
  messages: ModelMessage[];
  currentStart: number;
  archiveStart: number;
  compaction?: ManagedProgress['compaction'];
  text: string;
  pendingInputIds: Set<string>;
  turnId: string;
  attempt: number;
  phase: ManagedProgress['phase'];
  private turnSequence = 0;

  constructor(readonly context: RunContext) {
    const saved = context.progress;
    this.messages = saved ? [...saved.messages] : [...context.messages, ...(context.runtimeContext ? [context.runtimeContext] : []), { role: 'user', content: context.prompt,
      ...(context.images?.length ? { images: context.images } : {}) }];
    this.currentStart = saved?.currentStart ?? context.messages.length + (context.runtimeContext ? 1 : 0);
    this.compaction = saved?.compaction;
    this.archiveStart = saved?.archiveStart ?? saved?.currentStart ?? context.messages.length;
    this.text = saved?.text ?? '';
    this.pendingInputIds = new Set(saved?.pendingInputIds);
    this.turnId = saved?.turnId ?? this.newTurnId();
    this.attempt = saved?.attempt ?? 0;
    this.phase = saved?.phase ?? 'ready';
  }

  waitingForInput() { return !!(this.context.isWaitingForInput?.() || this.context.inputSignal?.aborted); }

  takeUserInput(): boolean {
    this.context.signal.throwIfAborted();
    if (this.waitingForInput()) return false;
    const input = this.context.userInput?.take() ?? [];
    if (!input.length) return false;
    this.context.userInput!.beginReply(this.text);
    this.text = '';
    this.messages.push(...input);
    for (const message of input) if (message.sourceMessageId) this.pendingInputIds.add(message.sourceMessageId);
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
    this.turnId = this.newTurnId();
    this.attempt = 0;
    this.phase = 'ready';
  }

  archiveMessages(): ModelMessage[] {
    return this.compaction ? [...this.compaction.archived, ...this.messages.slice(this.compaction.start)] : this.messages;
  }

  async applyProjection(messages: ModelMessage[], currentStart: number) {
    const archived = this.archiveMessages();
    this.messages = messages;
    this.currentStart = currentStart;
    this.compaction = { archived, start: messages.length };
    await this.save('ready');
  }

  async save(phase: ManagedProgress['phase'], recovery?: ModelRecovery) {
    this.phase = phase;
    await this.context.saveProgress?.({ messages: this.messages, currentStart: this.currentStart, archiveStart: this.archiveStart, contextSignature: this.context.contextSignature, compaction: this.compaction, text: this.text,
      pendingInputIds: [...this.pendingInputIds], turnId: this.turnId, attempt: this.attempt, phase,
      ...(recovery ? { recovery } : {}) });
  }

  private newTurnId() { return `${this.context.runId}:turn:${++this.turnSequence}`; }
}
