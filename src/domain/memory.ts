export type MemoryActor = 'user' | 'bot' | 'memory-review' | 'unknown';

export interface MemoryUsage {
  autoInjectedCount: number;
  activeReadCount: number;
  lastRecalledAt?: string;
  lastAutoInjectedAt?: string;
  lastActiveReadAt?: string;
}

export interface MemoryReviewSuggestion {
  content?: string;
  topic?: string;
  summary?: string;
  tags?: string[];
  reason?: string;
  createdAt: string;
}

export interface MemoryEntry {
  id: string;
  scope: 'bot' | 'team' | 'shared';
  ownerId: string;
  content: string;
  topic?: string;
  summary?: string;
  summaryRevision?: number;
  tags?: string[];
  pinned?: boolean;
  contentHash?: string;
  userMaintained?: boolean;
  createdBy?: MemoryActor;
  updatedBy?: MemoryActor;
  actorBotId?: string;
  supersedes?: string[];
  supersededBy?: string;
  promotedFromId?: string;
  consolidationReason?: string;
  reviewSuggestion?: MemoryReviewSuggestion;
  usage?: MemoryUsage;
  sourceIds: string[];
  allowedConversationIds: string[];
  status: 'candidate' | 'approved' | 'revoked' | 'superseded';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRevisionRecord {
  id: string;
  memoryId: string;
  revision: number;
  content: string;
  topic?: string;
  summary?: string;
  tags?: string[];
  pinned?: boolean;
  userMaintained?: boolean;
  scope: MemoryEntry['scope'];
  ownerId: string;
  allowedConversationIds: string[];
  sourceIds: string[];
  status: MemoryEntry['status'];
  createdBy?: MemoryActor;
  updatedBy?: MemoryActor;
  actorBotId?: string;
  supersedes?: string[];
  supersededBy?: string;
  consolidationReason?: string;
  createdAt: string;
}

export interface MemoryRecallInput {
  query?: string;
  ids?: string[];
  topic?: string;
  offset?: number;
  limit?: number;
  includeHistory?: boolean;
}

export interface MemoryTopicDirectoryItem {
  topic: string;
  count: number;
  summary: string;
  ids: string[];
}

export interface MemoryDirectory {
  topics: MemoryTopicDirectoryItem[];
  totalRemaining: number;
  hasMore: boolean;
}

export interface MemorySelection {
  pinnedEntries: MemoryEntry[];
  relevantEntries: MemoryEntry[];
  fullEntries: MemoryEntry[];
  omittedEntries: MemoryEntry[];
  directory: MemoryDirectory;
  estimatedTokens: number;
  budgetTokens: number;
}

export interface MemoryConsolidationStatus {
  partitionKey: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  taskId?: string;
  lastCompletedAt?: string;
  lastResult?: string;
  error?: string;
}

export function normalizeMemoryContent(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function normalizedAllowedConversations(
  entry: Pick<MemoryEntry, 'scope' | 'ownerId' | 'allowedConversationIds'>,
): string[] {
  return entry.scope === 'team'
    ? [entry.ownerId]
    : [...new Set(entry.allowedConversationIds)].sort();
}

export function memoryPartitionKey(
  entry: Pick<MemoryEntry, 'scope' | 'ownerId' | 'allowedConversationIds'>,
): string {
  return `${entry.scope}:${entry.ownerId}:${normalizedAllowedConversations(entry).join(',')}`;
}

export function memoryTopic(entry: Pick<MemoryEntry, 'topic' | 'scope'>): string {
  const topic = entry.topic?.trim();
  if (topic) return topic;
  return entry.scope === 'team' ? '团队约定' : entry.scope === 'shared' ? '共享资料' : '常用偏好';
}

export function memorySummary(
  entry: Pick<MemoryEntry, 'content' | 'summary' | 'summaryRevision' | 'revision'>,
  maxLength = 80,
): string {
  const validSummary =
    entry.summary?.trim() &&
    (entry.summaryRevision === undefined || entry.summaryRevision === entry.revision)
      ? entry.summary.trim()
      : '';
  const source = (validSummary || entry.content).replace(/\s+/g, ' ').trim();
  if (source.length <= maxLength) return source;
  const firstSentence = source.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxLength && firstSentence.length >= 8)
    return firstSentence;
  return `${source.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function searchableMemoryText(
  entry: Pick<
    MemoryEntry,
    'content' | 'topic' | 'summary' | 'summaryRevision' | 'revision' | 'tags'
  >,
): string {
  const validSummary =
    entry.summary?.trim() &&
    (entry.summaryRevision === undefined || entry.summaryRevision === entry.revision)
      ? entry.summary.trim()
      : '';
  return [entry.topic?.trim(), validSummary, ...(entry.tags ?? []), entry.content]
    .filter(Boolean)
    .join('\n');
}

export function estimateMemoryTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [])
    .length;
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
}

export function computeMemoryBudgetTokens(contextWindow?: number): number {
  if (contextWindow && contextWindow < 8000) {
    return Math.max(120, Math.min(2000, Math.floor(contextWindow * 0.25)));
  }
  return 2000;
}
