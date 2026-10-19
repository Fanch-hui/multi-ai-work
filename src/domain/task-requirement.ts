export interface RequirementUpdate {
  version: number;
  messageId: string;
  conversationId: string;
  content: string;
  artifactIds: string[];
  createdAt: string;
}
export interface TaskRequirement {
  taskId: string;
  version: number;
  updates: RequirementUpdate[];
}
