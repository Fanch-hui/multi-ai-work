import type { Message } from './types.js';

export interface ChiefWorkContext {
  id: string;
  homeConversationId: string;
  title: string;
  currentPartId: string;
  legacyConversationId?: string;
  legacyTaskId?: string;
  routineId?: string;
  createdAt: string;
}

export interface ChiefContextPart {
  id: string;
  contextId: string;
  conversationId: string;
  previousPartId?: string;
  handoff?: string;
  sourceMessageIds: string[];
  sourceArtifactIds: string[];
  createdAt: string;
}

export interface ChiefInput {
  id: string;
  homeConversationId: string;
  messageId: string;
  requestId: string;
  fingerprint: string;
  content?: string;
  artifactIds: string[];
  focusContextId?: string;
  focusRevision?: number;
  targetContextId?: string;
  workspaceId?: string;
  newContext?: boolean;
  replyToMessageId?: string;
  references?: import('./conversation-reference.js').ConversationReference[];
  status: 'pending' | 'routing' | 'clarification' | 'dispatched' | 'failed' | 'cancelled';
  contextId?: string;
  taskIds: string[];
  routingTaskId?: string;
  question?: string;
  candidateContextIds?: string[];
  error?: string;
  attempt?: number;
  clarificationAnswer?: string;
  createdAt: string;
}

export interface ChiefTimelineEntry {
  id: string;
  homeConversationId: string;
  displaySequence: number;
  messageId: string;
  inputId?: string;
}

export interface ChiefContextView extends ChiefWorkContext {
  conversationIds: string[];
  conversationId: string;
  workspaceId: string;
  activeTaskIds: string[];
}

export interface ChiefSnapshot {
  homeConversationId: string;
  focusContextId?: string;
  contexts: ChiefContextView[];
  inputs: ChiefInput[];
}

export interface ChiefTimelinePage {
  messages: Message[];
  nextBefore?: number;
}

export interface ChiefRouteDecision {
  action: 'continue' | 'new' | 'clarify';
  contextId?: string;
  workspaceId?: string;
  legacyConversationId?: string;
  legacyTaskId?: string;
  title?: string;
  question?: string;
  candidateContextIds?: string[];
}

export interface ChiefModelJob {
  instructions: string;
  prompt: string;
}
