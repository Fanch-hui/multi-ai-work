export interface ChiefHistorySearchInput {
  query?: string;
  contextId?: string;
  workspaceId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ChiefHistoryHit {
  messageId: string;
  conversationId: string;
  contextId?: string;
  taskId?: string;
  workspaceId: string;
  sequence: number;
  createdAt: string;
  authorType: 'user' | 'bot' | 'system';
  title: string;
  content: string;
  artifactIds: string[];
}

export interface ChiefHistorySearchResult {
  items: ChiefHistoryHit[];
  partial: boolean;
}

export interface ChiefHistoryReadResult {
  anchorMessageId: string;
  conversationId: string;
  contextId?: string;
  messages: ChiefHistoryHit[];
}
