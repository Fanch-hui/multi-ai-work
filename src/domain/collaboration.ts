export interface CollaborationRequest {
  id: string;
  requestId: string;
  conversationId: string;
  sourceTaskId: string;
  sourceBotId: string;
  targetBotId: string;
  chiefTaskId: string;
  goal: string;
  expectedOutput: string;
  artifactIds: string[];
  status: 'requested' | 'assigned' | 'declined' | 'completed' | 'failed';
  targetTaskId?: string;
  awaitingTaskResume?: boolean;
  deliveryError?: string;
  replyTaskId?: string;
  feedback?: string;
  createdAt: string;
  updatedAt: string;
}
