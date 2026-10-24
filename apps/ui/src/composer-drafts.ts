import type { ConversationReferenceOption } from '../../../src/domain/conversation-reference.js';
import { useSyncExternalStore, type SetStateAction } from 'react';
import type { Artifact, Conversation } from '../../../src/domain/types.js';
import {
  ATTACHMENT_LIMIT_MESSAGE,
  MAX_MESSAGE_ATTACHMENTS,
  requireAttachmentCapacity,
} from '../../../src/domain/attachment-policy.js';

export interface ComposerDraft {
  targetContextId?: string;
  references?: ConversationReferenceOption[];
  replyToMessageId?: string;
  content: string;
  targets: string[];
  attachments: Artifact[];
  requestId: string;
  sending: boolean;
  attaching: boolean;
  error: string;
}
type DraftContent = Pick<
  ComposerDraft,
  'content' | 'targets' | 'attachments' | 'references' | 'replyToMessageId' | 'targetContextId'
>;
export interface DraftAttachmentReference {
  conversationId: string;
  artifactIds: string[];
}

export function composerSubmission(conversation: Conversation, draft: ComposerDraft) {
  return {
    conversationId: conversation.id,
    content: draft.content.trim(),
    targetBotIds:
      conversation.purpose !== 'chief' && draft.targets.length ? draft.targets : undefined,
    artifactIds: draft.attachments.map((artifact) => artifact.id),
    requestId: draft.requestId,
    ...(draft.references?.length
      ? { references: draft.references.map(({ kind, id }) => ({ kind, id })) }
      : {}),
    ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
    ...(draft.targetContextId ? { targetContextId: draft.targetContextId } : {}),
  };
}

export class ComposerDraftStore {
  private drafts = new Map<string, ComposerDraft>();
  private listeners = new Map<string, Set<() => void>>();
  private attachmentListeners = new Set<() => void>();
  private sendingAttachments = new Map<string, string[]>();
  private attachmentSignature = '[]';

  attachmentSnapshot(): DraftAttachmentReference[] {
    const result: DraftAttachmentReference[] = [];
    for (const [conversationId, draft] of this.drafts) {
      const artifactIds = [
        ...new Set([
          ...draft.attachments.map((artifact) => artifact.id),
          ...(this.sendingAttachments.get(conversationId) ?? []),
        ]),
      ].sort();
      if (artifactIds.length) result.push({ conversationId, artifactIds });
    }
    return result.sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  }

  subscribeAttachments(listener: () => void) {
    this.attachmentListeners.add(listener);
    return () => {
      this.attachmentListeners.delete(listener);
    };
  }

  private notifyAttachments() {
    const signature = JSON.stringify(this.attachmentSnapshot());
    if (signature === this.attachmentSignature) return;
    this.attachmentSignature = signature;
    this.attachmentListeners.forEach((listener) => listener());
  }

  read(id: string): ComposerDraft {
    let draft = this.drafts.get(id);
    if (!draft) {
      draft = {
        content: '',
        targets: [],
        attachments: [],
        requestId: crypto.randomUUID(),
        sending: false,
        attaching: false,
        error: '',
      };
      this.drafts.set(id, draft);
    }
    return draft;
  }

  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }

  update(id: string, patch: Partial<ComposerDraft>) {
    this.drafts.set(id, { ...this.read(id), ...patch });
    if (patch.attachments !== undefined || patch.sending !== undefined) this.notifyAttachments();
    this.listeners.get(id)?.forEach((listener) => listener());
  }

  edit(id: string, patch: Partial<DraftContent>) {
    this.update(id, { ...patch, requestId: crypto.randomUUID() });
  }

  beginSend(id: string): ComposerDraft | undefined {
    const draft = this.read(id);
    if (draft.sending || draft.attaching || (!draft.content.trim() && !draft.attachments.length))
      return;
    this.sendingAttachments.set(
      id,
      draft.attachments.map((artifact) => artifact.id),
    );
    this.update(id, { sending: true, error: '' });
    return draft;
  }

  finishSend(id: string, requestId: string, error?: string) {
    this.sendingAttachments.delete(id);
    if (error !== undefined) {
      this.update(id, { sending: false, error });
      return;
    }
    const draft = this.read(id);
    this.update(id, {
      sending: false,
      ...(draft.requestId === requestId
        ? {
            content: '',
            targets: [],
            attachments: [],
            references: undefined,
            replyToMessageId: undefined,
            targetContextId: undefined,
            requestId: crypto.randomUUID(),
            error: '',
          }
        : {}),
    });
  }

  beginAttachment(id: string, incoming = 1): boolean {
    const draft = this.read(id);
    if (draft.attaching || draft.sending) return false;
    if (draft.attachments.length + incoming > MAX_MESSAGE_ATTACHMENTS) {
      this.update(id, { error: ATTACHMENT_LIMIT_MESSAGE });
      return false;
    }
    this.update(id, { attaching: true, error: '' });
    return true;
  }

  appendAttachments(id: string, items: Artifact[]) {
    const attachments = this.read(id).attachments;
    requireAttachmentCapacity(attachments.length, items.length);
    if (items.length) this.edit(id, { attachments: [...attachments, ...items] });
  }
}

export const composerDrafts = new ComposerDraftStore();

export function useComposerDraft(conversationId: string) {
  const draft = useSyncExternalStore(
    (listener) => composerDrafts.subscribe(conversationId, listener),
    () => composerDrafts.read(conversationId),
    () => composerDrafts.read(conversationId),
  );
  function setField<K extends keyof DraftContent>(
    field: K,
    value: SetStateAction<DraftContent[K]>,
  ) {
    const current = composerDrafts.read(conversationId)[field];
    const next =
      typeof value === 'function'
        ? (value as (previous: DraftContent[K]) => DraftContent[K])(current)
        : value;
    composerDrafts.edit(conversationId, { [field]: next });
  }
  return {
    draft,
    setReferences: (value: ConversationReferenceOption[]) => setField('references', value),
    setContent: (value: SetStateAction<string>) => setField('content', value),
    setTargets: (value: SetStateAction<string[]>) => setField('targets', value),
    setAttachments: (value: SetStateAction<Artifact[]>) => setField('attachments', value),
  };
}
