export type RoutineSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] };

export interface Routine {
  id: string;
  name: string;
  botId: string;
  workspaceId: string;
  conversationId: string;
  goal: string;
  expectedOutput: string;
  inputArtifactIds: string[];
  schedule: RoutineSchedule;
  timeZone: string;
  missedRunPolicy: 'latest' | 'skip';
  enabled: boolean;
  revision: number;
  nextRunAt?: string;
  pendingAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineOccurrence {
  id: string;
  routineId: string;
  revision: number;
  scheduledAt: string;
  triggeredAt: string;
  taskId?: string;
  source: 'schedule' | 'manual';
  reason?: string;
}

export interface TaskTrigger {
  type: 'routine';
  routineId: string;
  occurrenceId: string;
  automatic: boolean;
}
