import { useState } from 'react';
import type { Conversation, Snapshot } from '../../../src/domain/types.js';
import { Button, ErrorNote } from './components.js';
import { composerDrafts } from './composer-drafts.js';
import { errorMessage } from './api.js';
import { requireAttachmentCapacity } from '../../../src/domain/attachment-policy.js';

export function ChiefHistoryContinue({
  data,
  conversation,
  onSelectConversation,
}: {
  data: Snapshot;
  conversation: Conversation;
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
      const anchor = data.messages
        .filter((message) => message.conversationId === conversation.id)
        .at(-1);
      composerDrafts.edit(home, {
        targetContextId: data.chief?.contexts.find((context) =>
          context.conversationIds.includes(conversation.id),
        )?.id,
        replyToMessageId: anchor?.id,
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
