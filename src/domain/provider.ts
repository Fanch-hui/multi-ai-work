import type { Bot, Connection, ModelInfo, Capabilities, SessionBinding, Usage } from './types.js';
import type { ModelRecovery } from './recovery.js';

export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface ModelImage { artifactId: string; mimeType: string; width?: number; height?: number; }
export interface ToolContentResult { content: ({ type: 'text'; text: string } | { type: 'image'; image: ModelImage })[]; isError?: boolean; }
export interface ModelMessage { role: 'user' | 'assistant' | 'tool'; content: string; images?: ModelImage[]; callId?: string; toolCalls?: { id: string; name: string; arguments: string }[]; providerItems?: unknown[];
  sourceMessageId?: string; sourceSequence?: number; }
export interface ManagedProgress {
  messages: ModelMessage[];
  currentStart: number;
  text: string;
  pendingInputIds: string[];
  turnId: string;
  attempt: number;
  phase: 'ready' | 'request' | 'tools' | 'complete';
  recovery?: ModelRecovery;
}
export interface RunUserInput {
  take(): ModelMessage[];
  acknowledge?(messageIds: string[]): void;
  hasPending(): boolean;
  subscribe(listener: () => void): () => void;
  beginReply(output?: string): void;
}
export interface ProviderEvent { type: 'text' | 'tool' | 'usage' | 'context' | 'compaction' | 'status'; data: Record<string, unknown>; }
export interface NativeMcp { command: string; args: string[]; env: Record<string, string>; }
export interface NativeTools {
  names: string[];
  authorize(name: string, args: Record<string, unknown>, callId: string): Promise<Record<string, unknown>>;
  complete(name: string, args: Record<string, unknown>, callId: string, result: unknown): Promise<unknown>;
  fail(name: string, callId: string, error: string): void;
}
export interface RunContext {
  runId: string; bot: Bot; connection: Connection; binding: SessionBinding; workspacePath: string;
  prompt: string; messages: ModelMessage[]; instructions: string; tools: ToolDefinition[];
  images?: ModelImage[];
  resolveImage?(image: ModelImage): Promise<{ mimeType: string; data: string }>;
  signal: AbortSignal; nativeMcp: NativeMcp;
  nativeTools?: NativeTools;
  emit(event: ProviderEvent): void;
  parallelToolNames?: readonly string[];
  executeTool(name: string, args: Record<string, unknown>, callId: string): Promise<unknown>;
  getSecret(ref?: string): Promise<string | undefined>;
  saveSecret(ref: string, value: string): Promise<void>;
  persistBinding(nativeSessionId: string): void;
  recoverContext?(messages: ModelMessage[]): Promise<ModelMessage[] | undefined>;
  progress?: ManagedProgress;
  saveProgress?(progress: ManagedProgress): Promise<void>;
  deferRecovery?: boolean;
  isWaitingForInput?(): boolean;
  inputSignal?: AbortSignal;
  userInput?: RunUserInput;
}
export interface ProviderResult { text: string; usage?: Usage; nativeSessionId?: string; messages?: ModelMessage[];
  outcome?: 'completed' | 'waiting_input'; modelDurationMs?: number; }
export interface ProbeContext { connection: Connection; signal: AbortSignal; getSecret(ref?: string): Promise<string | undefined>; saveSecret?(ref: string, value: string): Promise<void>; }
export interface ProbeResult { models: ModelInfo[]; capabilities: Capabilities; version?: string; accountScope?: string; }
export interface ProviderAdapter { kind: Connection['provider']; probe(context: ProbeContext): Promise<ProbeResult>; run(context: RunContext): Promise<ProviderResult>; close?(): Promise<void>; }
export class AuthenticationRequiredError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthenticationRequiredError'; }
}
