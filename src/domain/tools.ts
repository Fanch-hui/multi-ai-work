import type { Artifact, Bot, Conversation, MemoryEntry, MemoryRecallInput, Task, ToolConnection, Workspace, Skill, ProcessRecord, UserQuestion } from './types.js';
import type { ToolDefinition } from './provider.js';
import type { PlanStepUpdate, TaskPlan, TaskPlanInput } from './task-plan.js';

export interface TaskGroupInput {
  name: string; goal: string; memberIds: string[]; expectedOutput?: string; workspaceId?: string;
  artifactIds?: string[];
}
export interface CommandInput { command: string; args: string[]; background?: boolean; workdir?: string; timeoutMs?: number; }
export interface SecurityScanInput { paths: string[]; timeoutMs?: number; }
export interface ProcessTools {
  run(input: CommandInput, options?: { approved: boolean }): Promise<unknown>;
  list(): ProcessRecord[];
  read(input: { processId: string; offset?: number; limit?: number; waitMs?: number }): Promise<unknown>;
  stop(processId: string): Promise<unknown>;
}

export interface ToolExecutionContext {
  callId?: string;
  resumeOperations?: Record<string, string>;
  assertAuthorized?(): void;
  recordTiming?(stage: 'networkQueueMs', durationMs: number): void;
  markDispatched?(): void;
  runId: string; task: Task; botId: string; conversation: Conversation; workspace: Workspace;
  signal: AbortSignal; requestApproval(toolName: string, summary: string, args: Record<string, unknown>): Promise<boolean>;
  listArtifacts(): Artifact[]; registerArtifact(input: Omit<Artifact, 'id' | 'createdAt'>): Artifact;
  findArtifact(id: string): Artifact | undefined;
  postMessage(content: string, artifactIds?: string[], conversationId?: string): string;
  readMessages(after?: number, limit?: number, around?: number): unknown;
  searchMessages?(query: string, limit?: number): unknown;
  getObservedFileVersion?(path: string): string | undefined;
  observeFile?(path: string, version: string): void;
  ownsFile?(path: string, version: string): boolean;
  processes?: ProcessTools;
  scanCodeSecurity?(input: SecurityScanInput): Promise<unknown>;
  askUser?(input: { question: string; options?: { label: string; description?: string }[] }): UserQuestion;
  delegateTask(botId: string, goal: string, expectedOutput: string, dependencyIds?: string[], artifactIds?: string[], planStepId?: string): Task;
  getTask(id: string): Task | undefined;
  stopTask?(input: { taskId?: string; runId?: string }): Promise<unknown>;
  sendTaskInput?(input: { taskId?: string; runId?: string; content: string; artifactIds?: string[] }): Promise<unknown>;
  reconcileTask?(input: { taskId?: string; runId?: string; outcome: 'succeeded' | 'not_executed' }): Promise<unknown>;
  listBots?(): unknown;
  configureBot?(input: Record<string, unknown>): Bot;
  createTaskGroup?(input: TaskGroupInput): { conversation: Conversation; task: Task };
  setTaskPlan?(input: TaskPlanInput): TaskPlan;
  getTaskPlan?(): TaskPlan | undefined;
  updatePlanStep?(input: PlanStepUpdate): TaskPlan;
  recallMemory(input: string | MemoryRecallInput): unknown;
  proposeMemory(content: string, scope: MemoryEntry['scope'], sourceIds: string[], metadata?: { topic?: string; summary?: string; tags?: string[] }): MemoryEntry;
  manageMemory?(input: Record<string, unknown>): unknown;
  getSecret(ref?: string): Promise<string | undefined>;
  toolConnections: ToolConnection[]; skills: Skill[];
  defaultSearchConnectionId?: string;
}
export interface ToolRegistry {
  definitions(context: ToolExecutionContext): ToolDefinition[];
  prepare?(context: ToolExecutionContext): Promise<void>;
  canonical?(name: string, args: Record<string, unknown>, context: ToolExecutionContext): { name: string; args: Record<string, unknown> };
  release?(runId: string): void;
  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>;
  probeConnection(connection: ToolConnection, getSecret: ToolExecutionContext['getSecret']): Promise<string[]>;
  removeConnection?(connectionId: string): Promise<void>;
  close(): Promise<void>;
}
