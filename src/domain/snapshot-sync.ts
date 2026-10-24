import type {
  Conversation,
  Message,
  ProcessRecord,
  Run,
  RunEvent,
  Snapshot,
  Task,
  TaskInput,
} from './types.js';
import type { TaskPlan } from './task-plan.js';

export interface SnapshotCursor {
  epoch: string;
  version: number;
  eventSequence?: number;
}
export interface MessagePage {
  messages: Message[];
  nextBefore?: number;
}
export interface SnapshotView {
  snapshot: Snapshot;
  cursor: SnapshotCursor;
  history?: { conversationId: string; nextBefore?: number };
}
export interface SnapshotDelta {
  chief?: import('./chief-work.js').ChiefSnapshot;
  cursor: SnapshotCursor;
  reset?: boolean;
  messages: Message[];
  tasks: Task[];
  runs: Run[];
  processes: ProcessRecord[];
  conversations?: Conversation[];
  conversationUpdates?: Conversation[];
  taskPlans?: TaskPlan[];
  taskInputs?: TaskInput[];
  events?: RunEvent[];
}
