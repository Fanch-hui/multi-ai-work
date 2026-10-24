import type {
  ChiefContextPart,
  ChiefInput,
  ChiefTimelineEntry,
  ChiefWorkContext,
} from '../domain/chief-work.js';
import type { State } from './state.js';

export function removeChiefConversation(state: State, conversationId: string) {
  const s = state.storage;
  const messageIds = new Set(s.messages(conversationId).map((message) => message.id));
  for (const entry of s.all<ChiefTimelineEntry>('chief_timeline'))
    if (messageIds.has(entry.messageId)) s.delete('chief_timeline', entry.id);

  const parts = s.all<ChiefContextPart>('chief_parts');
  const removedParts = new Map(
    parts.filter((part) => part.conversationId === conversationId).map((part) => [part.id, part]),
  );
  const affectedContexts = new Set([...removedParts.values()].map((part) => part.contextId));
  const remainingParts: ChiefContextPart[] = [];
  for (const part of parts) {
    if (part.conversationId === conversationId) {
      s.delete('chief_parts', part.id);
      continue;
    }
    const sourceMessageIds = part.sourceMessageIds.filter((id) => !messageIds.has(id));
    let previousPartId = part.previousPartId;
    while (previousPartId && removedParts.has(previousPartId))
      previousPartId = removedParts.get(previousPartId)!.previousPartId;
    const updated = { ...part, sourceMessageIds, previousPartId };
    if (
      sourceMessageIds.length !== part.sourceMessageIds.length ||
      previousPartId !== part.previousPartId
    )
      s.put('chief_parts', updated);
    remainingParts.push(updated);
  }

  const removedContexts = new Set<string>();
  for (const context of s.all<ChiefWorkContext>('chief_contexts')) {
    if (!affectedContexts.has(context.id) && context.legacyConversationId !== conversationId)
      continue;
    const parts = remainingParts
      .filter((part) => part.contextId === context.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!parts.length) {
      removedContexts.add(context.id);
      s.delete('chief_contexts', context.id);
      continue;
    }
    if (
      context.legacyConversationId === conversationId ||
      !parts.some((part) => part.id === context.currentPartId)
    )
      s.put('chief_contexts', {
        ...context,
        currentPartId: parts.some((part) => part.id === context.currentPartId)
          ? context.currentPartId
          : parts[parts.length - 1]!.id,
        legacyConversationId:
          context.legacyConversationId === conversationId
            ? undefined
            : context.legacyConversationId,
        legacyTaskId:
          context.legacyConversationId === conversationId ? undefined : context.legacyTaskId,
      });
  }

  for (const input of s.all<ChiefInput>('chief_inputs')) {
    if (messageIds.has(input.messageId)) {
      s.delete('chief_inputs', input.id);
      continue;
    }
    if (
      removedContexts.has(input.targetContextId ?? '') ||
      removedContexts.has(input.contextId ?? '') ||
      messageIds.has(input.replyToMessageId ?? '')
    )
      s.put('chief_inputs', {
        ...input,
        status: 'failed',
        targetContextId: undefined,
        contextId: undefined,
        replyToMessageId: undefined,
        routingTaskId: undefined,
        candidateContextIds: input.candidateContextIds?.filter((id) => !removedContexts.has(id)),
        error: '引用的历史已删除，请选择事项后重试。',
      });
  }

  const homeId = state.settings().mainConversationId;
  const focusKey = `chief-focus:${homeId}`;
  const focus = s.metadata<{ contextId?: string; revision: number }>(focusKey);
  if (focus?.contextId && removedContexts.has(focus.contextId))
    s.setMetadata(focusKey, { revision: focus.revision + 1 });
}
