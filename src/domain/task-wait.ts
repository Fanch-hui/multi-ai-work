export interface TaskWait {
  id: string;
  taskId: string;
  runId: string;
  conversationId: string;
  botId: string;
  kind: 'approval' | 'browser-handoff' | 'browser-resource';
  summary: string;
  status: 'pending' | 'resumed' | 'cancelled';
  resourceId?: string;
  createdAt: string;
  resolvedAt?: string;
}
