import type { BotPresetBinding, SkillSource } from './market.js';
import type { TaskPlan } from './task-plan.js';
import type { TaskActivity } from './task-activity.js';
import type { TaskRequirement } from './task-requirement.js';
import type { ModelRecovery } from './recovery.js';
import type { MemoryEntry } from './memory.js';
export type {
  MemoryActor,
  MemoryUsage,
  MemoryReviewSuggestion,
  MemoryEntry,
  MemoryRevisionRecord,
  MemoryRecallInput,
  MemoryTopicDirectoryItem,
  MemoryDirectory,
  MemorySelection,
  MemoryConsolidationStatus,
} from './memory.js';
export type ProviderKind = 'antigravity' | 'chatgpt' | 'qoder' | 'custom';
export type QoderService = 'WebSearch' | 'WebFetch' | 'ImageSearch' | 'ImageGen' | 'SecurityScan';
export type Protocol = 'chat-completions' | 'responses';
export type CapabilityState = 'supported' | 'unsupported' | 'unverified';
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'recovering'
  | 'waiting_children'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type TaskQueueReason = 'global_limit' | 'account_limit' | 'session_busy' | 'dependencies';
export type RunStatus =
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxContextWindow?: number;
  maxContextWindowSource?: 'provider' | 'official-catalog';
  reasoning?: string[];
  reasoningSource?: 'provider' | 'official-catalog';
  imageInput?: CapabilityState;
  imageInputSource?: 'provider' | 'official-catalog';
}
export interface Capabilities {
  runtimeKind: 'native-agent' | 'managed-model';
  contextOwner: 'native' | 'app';
  tools: CapabilityState;
  resume: CapabilityState;
  imageInput: CapabilityState;
  compaction: CapabilityState;
  contextUsage: CapabilityState;
  permissionEnforcement: 'gateway' | 'native-hooks' | 'mixed' | 'native-cli' | 'unverified';
}
export interface Connection {
  id: string;
  name: string;
  provider: ProviderKind;
  protocol?: Protocol;
  baseUrl?: string;
  executable?: string;
  executableMode?: 'auto' | 'explicit';
  profilePath?: string;
  authMode?: 'oauth' | 'local' | 'pat' | 'api-key' | 'none';
  secretRef?: string;
  concurrency: number;
  status: 'untested' | 'ready' | 'error' | 'needs_auth';
  error?: string;
  models: ModelInfo[];
  capabilities?: Capabilities;
  version?: string;
  accountScope?: string;
  revision: number;
  createdAt: string;
}
export type ApprovalMode = 'ask' | 'auto';
export interface Bot {
  preset?: BotPresetBinding;
  personalInstructions?: string;
  id: string;
  name: string;
  role: string;
  instructions: string;
  connectionId: string;
  model: string;
  reasoning?: string;
  contextWindow?: number;
  outputReserve?: number;
  compactionThreshold?: number;
  color: string;
  avatar?: string;
  toolNames: string[];
  approvalMode?: ApprovalMode;
  skillIds: string[];
  toolConnectionIds?: string[];
  qoderServices?: QoderService[];
  memoryMode: 'off' | 'manual' | 'propose';
  revision: number;
  archived: boolean;
}
export interface Conversation {
  id: string;
  name: string;
  kind: 'private' | 'group';
  memberIds: string[];
  chiefId?: string;
  workspaceId: string;
  createdAt: string;
  purpose?: 'chief' | 'task';
  sourceConversationId?: string;
  sourceTaskId?: string;
  archived?: boolean;
  model?: string;
  reasoning?: string;
  nameEdited?: boolean;
  unreadCount?: number;
}
export interface Workspace {
  id: string;
  name: string;
  path: string;
  writable: boolean;
}
export interface Message {
  id: string;
  conversationId: string;
  sequence: number;
  authorType: 'user' | 'bot' | 'system';
  authorBotId?: string;
  runId?: string;
  content: string;
  artifactIds: string[];
  status: 'draft' | 'committed' | 'interrupted';
  createdAt: string;
  targetBotIds?: string[];
  mentionedBotIds?: string[];
}
export interface TaskInput {
  id: string;
  kind: 'user-input';
  taskId: string;
  botId: string;
  conversationId: string;
  messageId: string;
  status: 'pending' | 'claimed' | 'delivered';
  runId?: string;
  createdAt: string;
  deliveredAt?: string;
  requirementVersion?: number;
}
export interface SessionBinding {
  id: string;
  botId: string;
  conversationId: string;
  connectionId: string;
  generation: number;
  configRevision: number;
  connectionRevision: number;
  workspaceId: string;
  nativeSessionId?: string;
  lastDeliveredSequence: number;
  accountScope?: string;
  purpose?: 'memory' | 'question-decision';
  model?: string;
  reasoning?: string;
  identityHash?: string;
  memoryVersions?: Record<string, number>;
}
export interface Task {
  id: string;
  conversationId: string;
  botId: string;
  parentId?: string;
  dependencyIds: string[];
  goal: string;
  expectedOutput: string;
  status: TaskStatus;
  runIds: string[];
  artifactIds: string[];
  inputArtifactIds?: string[];
  result?: string;
  error?: string;
  reconciliationRequired?: boolean;
  coordinationPaused?: boolean;
  requestId: string;
  depth: number;
  createdAt: string;
  updatedAt: string;
  kind?: 'memory-review' | 'question-decision' | 'context-compaction';
  questionId?: string;
  queueReason?: TaskQueueReason;
  planId?: string;
  planStepId?: string;
  sourceMessageId?: string;
  activity?: TaskActivity;
  requirement?: TaskRequirement;
  recovery?: ModelRecovery;
  resumeFromRunId?: string;
  contextCompactionOutcome?: 'compressed' | 'unchanged';
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  source: 'reported' | 'estimated' | 'unknown';
}
export interface RunMetrics {
  requests: number;
  summaryRequests: number;
  usageRequests: number;
  usage?: Usage;
  cache?: { inputTokens: number; cachedInputTokens: number; requests: number };
  rate?: {
    outputTokens: number;
    durationMs: number;
    requests: number;
    source: 'reported' | 'estimated';
  };
}
export interface Run {
  id: string;
  taskId: string;
  botId: string;
  bindingId: string;
  status: RunStatus;
  configRevision: number;
  usage?: Usage;
  error?: string;
  createdAt: string;
  endedAt?: string;
  connectionId?: string;
  model?: string;
  inferenceDurationMs?: number;
  inferenceUsage?: Usage;
  modelDurationMs?: number;
  modelRequestCount?: number;
  contextUsage?: Record<string, unknown>;
  confirmedUsage?: Usage;
  metrics?: RunMetrics;
  requirementVersion?: number;
  cancelRequestedAt?: string;
  resumeFromRunId?: string;
}
export interface RunEvent {
  id: string;
  runId: string;
  type: 'text' | 'tool' | 'approval' | 'usage' | 'context' | 'compaction' | 'status';
  data: Record<string, unknown>;
  createdAt: string;
}
export interface RunEventPage {
  events: RunEvent[];
  nextCursor?: number;
}
export interface ImageMetadata {
  mimeType: string;
  width: number;
  height: number;
  path: string;
}
export interface Artifact {
  contentSource?: import('./artifact-content.js').ArtifactContentSource;
  id: string;
  name: string;
  path: string;
  mimeType: string;
  sha256: string;
  size: number;
  taskId?: string;
  botId?: string;
  conversationId: string;
  createdAt: string;
  source?: string;
  workingPath?: string;
  purpose?: 'deliverable' | 'intermediate';
  requirementVersion?: number;
  superseded?: boolean;
  image?: ImageMetadata;
}
export interface Approval {
  id: string;
  runId: string;
  taskId: string;
  botId: string;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}
export interface UserQuestion {
  id: string;
  taskId: string;
  runId: string;
  botId: string;
  conversationId: string;
  question: string;
  options?: { label: string; description?: string }[];
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: string;
  answer?: string;
  answeredAt?: string;
  autoAnswerAt?: string;
  chiefTaskId?: string;
  answerSource?: 'user' | 'chief';
  answerBotId?: string;
  answerReason?: string;
  autoAnswerError?: string;
}
export interface ProcessRecord {
  id: string;
  runId: string;
  taskId: string;
  botId: string;
  conversationId: string;
  workspaceId: string;
  command: string;
  args: string[];
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'timed_out' | 'unknown';
  pid?: number;
  createdAt: string;
  endedAt?: string;
  code?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  stoppedByBotId?: string;
  stoppedByTaskId?: string;
}
export interface ContextCheckpoint {
  id: string;
  bindingId: string;
  generation: number;
  throughSequence: number;
  content: string;
  sourceMessageIds: string[];
  estimatedTokens: number;
  createdAt: string;
  artifactIds?: string[];
}
export interface ContextOperation {
  id: string;
  bindingId: string;
  generation: number;
  status: 'started' | 'completed' | 'failed' | 'unchanged';
  sourceMessageIds: string[];
  throughSequence: number;
  createdAt: string;
  reason?: string;
}
export interface ToolConnection {
  id: string;
  name: string;
  kind: 'mcp' | 'bridge' | 'search';
  transport?: 'stdio' | 'http';
  url?: string;
  command?: string;
  args?: string[];
  secretRef?: string;
  enabled: boolean;
  toolNames: string[];
  status: 'untested' | 'ready' | 'error';
  error?: string;
  searchBackend?: 'http' | 'tavily' | 'deepseek';
  searchMethod?: 'GET' | 'POST';
  searchQueryField?: string;
}
export interface Skill {
  id: string;
  name: string;
  path: string;
  content: string;
  description?: string;
  resourceRoot?: string;
  version?: string;
  bundled?: boolean;
  digest?: string;
  source?: SkillSource;
  missing?: boolean;
  presetOnly?: boolean;
}
export interface Settings {
  onboardingStatus?: 'pending' | 'skipped' | 'completed';
  maxActiveRuns: number;
  maxChildren: number;
  maxCoordinationRounds: number;
  autoAnswerMemberQuestions: boolean;
  trayEnabled: boolean;
  userAvatar?: string;
  mainBotId?: string;
  mainConversationId?: string;
  defaultSearchConnectionId?: string;
}
export interface Snapshot {
  connections: Connection[];
  bots: Bot[];
  conversations: Conversation[];
  workspaces: Workspace[];
  messages: Message[];
  tasks: Task[];
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
  questions: UserQuestion[];
  processes: ProcessRecord[];
  memories: MemoryEntry[];
  events: RunEvent[];
  toolConnections: ToolConnection[];
  skills: Skill[];
  settings: Settings;
  dataDirectory: string;
  bindings: SessionBinding[];
  checkpoints: ContextCheckpoint[];
  compactions: ContextOperation[];
  taskPlans: TaskPlan[];
  taskInputs: TaskInput[];
}
