import type { Message, Run } from '../domain/types.js';
import { Storage } from './storage.js';

function currentDraft(storage: Storage, messageId: string): Message | undefined {
  const message = storage.getMessage(messageId);
  return message?.status === 'draft' ? message : undefined;
}

export function runMessageSources(storage: Storage, runId: string): Set<string> {
  const sources = new Set<string>();
  let source: string | undefined = runId;
  while (source && !sources.has(source)) {
    sources.add(source);
    source = storage.get<Run>('runs', source)?.resumeFromRunId;
  }
  return sources;
}

export function streamRunMessage(storage: Storage, messageId: string, delta: string) {
  const message = currentDraft(storage, messageId);
  if (message) storage.updateMessage({ ...message, content: message.content + delta });
}

export function replaceRunMessage(storage: Storage, messageId: string, content: string) {
  const message = currentDraft(storage, messageId);
  if (message) storage.updateMessage({ ...message, content });
}

export function completeRunMessage(storage: Storage, draft: Message, content: string, artifactIds: string[]): Message {
  const message = currentDraft(storage, draft.id);
  if (!message) {
    const sources = runMessageSources(storage, draft.runId!);
    return storage.messages(draft.conversationId).filter(message => message.runId && sources.has(message.runId)
      && message.authorBotId === draft.authorBotId && message.status === 'committed').at(-1) ?? draft;
  }
  const completed: Message = { ...message, content, artifactIds, status: 'committed' };
  storage.updateMessage(completed);
  return completed;
}

export function interruptRunMessage(storage: Storage, messageId: string) {
  const message = currentDraft(storage, messageId);
  if (!message) return;
  if (message.content.trim() || message.artifactIds.length) storage.updateMessage({ ...message, status: 'interrupted' });
  else storage.deleteMessage(message.id);
}
