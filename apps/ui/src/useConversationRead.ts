import { useEffect, useState } from 'react';
import type { Conversation, Message } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { errorMessage } from './api.js';
import { ConversationReadReceipts, readableBotMessageIds } from './conversation-read.js';

export function conversationCanBeRead(
  visible: boolean,
  focused: boolean,
  messageView: boolean,
): boolean {
  return visible && focused && messageView;
}

function windowForeground(messageView = true) {
  return (
    typeof document !== 'undefined' &&
    conversationCanBeRead(document.visibilityState === 'visible', document.hasFocus(), messageView)
  );
}

export function useConversationRead(
  conversation: Conversation | undefined,
  messages: Message[],
  enabled: boolean,
  mutate: Mutate,
) {
  const [foreground, setForeground] = useState(windowForeground);
  const [receipts] = useState(() => new ConversationReadReceipts());
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  useEffect(() => {
    const update = () => setForeground(windowForeground());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);
  useEffect(() => {
    if (!conversation || !foreground || !windowForeground(enabled) || !conversation.unreadCount)
      return;
    const id = conversation.id;
    void receipts
      .mark(id, readableBotMessageIds(messages, id, conversation.chiefRole === 'home'), (params) =>
        mutate('conversations.read', params),
      )
      .then((changed) => {
        if (!changed) return;
        setFailure(undefined);
        setRevision((value) => value + 1);
      })
      .catch((cause) => setFailure({ id, message: errorMessage(cause) }));
  }, [conversation, messages, enabled, foreground, mutate, receipts, revision]);
  return {
    error: failure && failure.id === conversation?.id ? failure.message : '',
    retry: () => setRevision((value) => value + 1),
  };
}
