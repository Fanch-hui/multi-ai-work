import { useEffect } from 'react';
import { request } from './api.js';
import {
  composerDrafts,
  type ComposerDraftStore,
  type DraftAttachmentReference,
} from './composer-drafts.js';

const RENEW_INTERVAL_MS = 60_000;

export function createAttachmentDraftRetention(
  store: ComposerDraftStore,
  retain: (drafts: DraftAttachmentReference[]) => Promise<unknown>,
) {
  let active = false;
  let sending = false;
  let pending = false;

  async function flush() {
    if (!active || sending || !pending) return;
    sending = true;
    pending = false;
    try {
      await retain(store.attachmentSnapshot());
    } catch (cause) {
      console.warn(
        '附件草稿续期失败，将自动重试：',
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      sending = false;
      if (active && pending) void flush();
    }
  }

  function renew() {
    pending = true;
    void flush();
  }

  return {
    start() {
      active = true;
      const unsubscribe = store.subscribeAttachments(renew);
      const timer = setInterval(renew, RENEW_INTERVAL_MS);
      renew();
      return () => {
        active = false;
        pending = false;
        clearInterval(timer);
        unsubscribe();
      };
    },
  };
}

const retention = createAttachmentDraftRetention(composerDrafts, (drafts) =>
  request('artifacts.retainDrafts', { drafts }),
);

export function useAttachmentDraftRetention() {
  useEffect(() => retention.start(), []);
}
