import type { Conversation, Message, ProcessRecord, Run, RunEvent, Snapshot, Task } from './types.js';

export interface SnapshotCursor { epoch: string; version: number; eventSequence?: number; }
export interface MessagePage { messages: Message[]; nextBefore?: number; }
export interface SnapshotView {
  snapshot: Snapshot; cursor: SnapshotCursor;
  history?: { conversationId: string; nextBefore?: number };
}
export interface SnapshotDelta {
  cursor: SnapshotCursor; reset?: boolean;
  messages: Message[]; tasks: Task[]; runs: Run[]; processes: ProcessRecord[];
  conversations?: Conversation[]; events?: RunEvent[];
}
