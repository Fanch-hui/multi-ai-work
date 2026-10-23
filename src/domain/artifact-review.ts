export interface ReviewTarget {
  artifactId: string;
  sha256: string;
  name: string;
  requirementTaskId?: string;
  requirementVersion?: number;
}

export interface ArtifactReview {
  id: string;
  requestId: string;
  conversationId: string;
  sourceTaskId?: string;
  targets: ReviewTarget[];
  reviewer: 'user' | 'bot';
  botId?: string;
  taskId?: string;
  outcome: 'accepted' | 'passed' | 'changes_requested';
  feedback: string;
  reworkTaskId?: string;
  createdAt: string;
}
