import { useState } from 'react';
import type { ChiefContextView } from '../../../src/domain/chief-work.js';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, ErrorNote } from './components.js';
import { composerDrafts } from './composer-drafts.js';
import { errorMessage } from './api.js';
import { requireAttachmentCapacity } from '../../../src/domain/attachment-policy.js';

export function ChiefHistoryContinue({
  data,
  conversation,
  mutate,
  onSelectConversation,
}: {
  data: Snapshot;
  conversation: Conversation;
  mutate: Mutate;
  onSelectConversation: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previous = composerDrafts.read(conversation.id);
  const hasDraft = !!previous.content.trim() || !!previous.attachments.length;
  async function continueWork(withDraft = false) {
    setBusy(true);
    setError('');
    try {
      const home = data.chief?.homeConversationId ?? data.settings.mainConversationId!;
      const draft = composerDrafts.read(home);
      if (withDraft)
        requireAttachmentCapacity(draft.attachments.length, previous.attachments.length);
      const context = await mutate<ChiefContextView>('chief.contexts.create', {
        title: conversation.name,
        workspaceId: conversation.workspaceId,
        legacyConversationId: conversation.id,
      });
      composerDrafts.edit(home, {
        targetContextId: context.id,
        ...(withDraft
          ? {
              content: [draft.content, previous.content].filter(Boolean).join('\n\n'),
              attachments: [...draft.attachments, ...previous.attachments],
            }
          : {}),
      });
      if (withDraft) composerDrafts.edit(conversation.id, { content: '', attachments: [] });
      onSelectConversation(home);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-2 px-2 py-3">
      <p className="text-xs text-slate-500">历史对话</p>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void continueWork()}>
          在管家继续
        </Button>
        {hasDraft && (
          <Button disabled={busy} onClick={() => void continueWork(true)}>
            带草稿继续
          </Button>
        )}
      </div>
    </div>
  );
}
