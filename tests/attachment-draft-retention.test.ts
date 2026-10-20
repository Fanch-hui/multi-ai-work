import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import { ComposerDraftStore } from '../apps/ui/src/composer-drafts.js';
import { createAttachmentDraftRetention } from '../apps/ui/src/useAttachmentDraftRetention.js';

vi.mock('../apps/ui/src/api.js', () => ({ request: vi.fn() }));

const attachment = (id: string) => ({ id }) as Artifact;

afterEach(() => vi.useRealTimers());

describe('draft attachment retention', () => {
  it('tracks every conversation, pending imports and sending files without reacting to text edits', () => {
    const store = new ComposerDraftStore();
    const changed = vi.fn();
    store.subscribeAttachments(changed);
    store.edit('first', { attachments: [attachment('original')] });
    const submission = store.beginSend('first')!;
    store.edit('first', { content: '新要求', attachments: [attachment('next')] });
    expect(store.beginAttachment('second')).toBe(true);
    store.appendAttachments('second', [attachment('imported')]);
    store.read('third');
    expect(store.attachmentSnapshot()).toEqual([
      { conversationId: 'first', artifactIds: ['next', 'original'] },
      { conversationId: 'second', artifactIds: ['imported'] },
    ]);
    expect(changed).toHaveBeenCalledTimes(3);
    store.edit('third', { content: '只有文字' });
    store.edit('first', { targets: ['member'] });
    expect(changed).toHaveBeenCalledTimes(3);
    store.finishSend('first', submission.requestId);
    expect(store.attachmentSnapshot()[0]).toEqual({
      conversationId: 'first',
      artifactIds: ['next'],
    });
    store.edit('first', { attachments: [] });
    expect(store.attachmentSnapshot()).toEqual([
      { conversationId: 'second', artifactIds: ['imported'] },
    ]);
  });

  it('releases successfully sent attachments while retaining a failed submission', () => {
    const store = new ComposerDraftStore();
    store.edit('first', { attachments: [attachment('file')] });
    const first = store.beginSend('first')!;
    store.finishSend('first', first.requestId, '连接失败');
    expect(store.attachmentSnapshot()).toEqual([
      { conversationId: 'first', artifactIds: ['file'] },
    ]);
    const retry = store.beginSend('first')!;
    store.finishSend('first', retry.requestId);
    expect(store.attachmentSnapshot()).toEqual([]);
  });

  it('serializes reports and sends the latest snapshot after an in-flight report completes', async () => {
    vi.useFakeTimers();
    const store = new ComposerDraftStore();
    let complete!: () => void;
    const retain = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const stop = createAttachmentDraftRetention(store, retain).start();
    store.edit('first', { attachments: [attachment('cancelled')] });
    store.edit('first', { attachments: [attachment('kept')] });
    expect(retain).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(retain.mock.calls).toEqual([
      [[]],
      [[{ conversationId: 'first', artifactIds: ['kept'] }]],
    ]);
    store.edit('first', { content: '不上传消息正文' });
    expect(retain).toHaveBeenCalledTimes(2);
    store.edit('first', { attachments: [] });
    expect(retain).toHaveBeenLastCalledWith([]);
    stop();
  });

  it('renews after a failure and stops its timer and subscription on cleanup', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ComposerDraftStore();
    store.edit('first', { attachments: [attachment('file')] });
    const retain = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const stop = createAttachmentDraftRetention(store, retain).start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledWith('附件草稿续期失败，将自动重试：', 'offline');
    expect(retain).toHaveBeenCalledTimes(2);
    expect(retain).toHaveBeenLastCalledWith([{ conversationId: 'first', artifactIds: ['file'] }]);
    stop();
    store.edit('first', { attachments: [] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(retain).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('keeps reports ordered across an effect cleanup and restart', async () => {
    vi.useFakeTimers();
    const store = new ComposerDraftStore();
    let complete!: () => void;
    const retain = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const retention = createAttachmentDraftRetention(store, retain);
    retention.start()();
    store.edit('first', { attachments: [attachment('file')] });
    const stop = retention.start();
    expect(retain).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(retain).toHaveBeenLastCalledWith([{ conversationId: 'first', artifactIds: ['file'] }]);
    stop();
  });
});
