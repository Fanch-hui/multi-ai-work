import type { Conversation, Message, Run, Snapshot, Task } from '../../../src/domain/types.js';

type FeedData = Pick<Snapshot, 'messages' | 'tasks' | 'runs'>;
export interface WorkingMember { task: Task; run: Run; }

export function conversationMessages(data: FeedData, conversation: Conversation): Message[] {
  return data.messages.filter(message => message.conversationId === conversation.id
    && (conversation.kind !== 'group' || message.authorType !== 'system')
    && (message.content.trim().length > 0 || message.artifactIds.length > 0))
    .sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt));
}

export function workingMembers(data: FeedData, conversation: Conversation, messages: Message[]): WorkingMember[] {
  const tasks = new Map(data.tasks.filter(task => task.conversationId === conversation.id
    && !task.kind && task.status === 'running').map(task => [task.id, task]));
  const streamingRuns = new Set(messages.filter(message => message.status === 'draft').map(message => message.runId));
  const members = new Map<string, WorkingMember>();
  for (const run of [...data.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const task = tasks.get(run.taskId);
    if (task && run.status === 'running' && !streamingRuns.has(run.id)) members.set(run.botId, { task, run });
  }
  return [...members.values()];
}

export function recoveringTasks(data: FeedData, conversation: Conversation, messages: Message[]): Task[] {
  if (conversation.kind !== 'private') return [];
  const streamingRuns = new Set(messages.filter(message => message.status === 'draft').map(message => message.runId));
  return data.tasks.filter(task => task.conversationId === conversation.id && !task.kind
    && task.status === 'recovering' && !task.runIds.some(id => streamingRuns.has(id)));
}
