import type { ModelRecovery } from './recovery.js';

export type ModelActivityKind =
  | 'waiting'
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'working'
  | 'finishing';

export interface TaskOperation {
  runId: string;
  callId: string;
  name: string;
  summary?: string;
  startedAt: string;
}

export interface TaskActivity {
  phase:
    | 'preparing'
    | 'model'
    | 'responding'
    | 'tool'
    | 'compacting'
    | 'queued'
    | 'recovering'
    | 'children'
    | 'approval'
    | 'input'
    | 'stopping'
    | 'finished';
  firstModelOutputAt?: string;
  /** Stable within one model request or operation, independent of streamed fragments. */
  activityKey?: string;
  /** At most four current operations; operationCount includes all active calls. */
  operations?: TaskOperation[];
  operationCount?: number;
  lastActivityAt?: string;
  lastModelActivityAt?: string;
  lastToolActivityAt?: string;
  modelActivity?: ModelActivityKind;
  toolName?: string;
  waitingFor?: string;
  checkpointId?: string;
  recovery?: ModelRecovery;
}
