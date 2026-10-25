import type { ChiefContextPart, ChiefWorkContext } from './chief-work.js';
import type { Message, Task } from './types.js';

export interface ChiefHistoryTaskView {
  id: string;
  title: string;
  kind: NonNullable<ChiefWorkContext['kind']>;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  partCount: number;
  taskCount: number;
  activeTaskIds: string[];
  deletable: boolean;
  deleteBlockedReason?: string;
}

export interface ChiefHistoryTaskList {
  items: ChiefHistoryTaskView[];
  nextBefore?: string;
}

export interface ChiefHistoryInstruction {
  messageId: string;
  conversationId: string;
  contextId: string;
  contextTitle: string;
  content: string;
  createdAt: string;
  taskIds: string[];
}

export interface ChiefHistoryTaskRead {
  context: ChiefHistoryTaskView;
  parts: ChiefContextPart[];
  part: ChiefContextPart;
  messages: Message[];
  nextBefore?: number;
  instructions: ChiefHistoryInstruction[];
  tasks: Task[];
}

export interface ChiefHistoryTaskListInput {
  query?: string;
  before?: string;
  limit?: number;
}

export interface ChiefHistoryTaskReadInput {
  contextId: string;
  partId?: string;
  before?: number;
  limit?: number;
}
