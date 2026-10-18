import type { ModelRecovery } from './recovery.js';

export type ModelActivityKind = 'waiting' | 'thinking' | 'responding' | 'tool' | 'working';

export interface TaskActivity {
  phase: 'preparing' | 'model' | 'responding' | 'tool' | 'compacting' | 'queued' | 'recovering' | 'children' | 'approval' | 'input' | 'stopping' | 'finished';
  lastActivityAt?: string;
  lastModelActivityAt?: string;
  lastToolActivityAt?: string;
  modelActivity?: ModelActivityKind;
  toolName?: string;
  waitingFor?: string;
  checkpointId?: string;
  recovery?: ModelRecovery;
}
