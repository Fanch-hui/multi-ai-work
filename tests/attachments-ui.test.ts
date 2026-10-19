import { createElement, type DragEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import type { Mutate } from '../apps/ui/src/store.js';
import { composerDrafts } from '../apps/ui/src/composer-drafts.js';
import { useAttachments } from '../apps/ui/src/useAttachments.js';

class FileReaderFixture {
  result = '';
  onload?: () => void;
  async readAsDataURL(file: File) {
    this.result = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
    this.onload?.();
  }
}
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal('FileReader', FileReaderFixture);
  const conversationId = crypto.randomUUID();
  const mutate = vi.fn(
    async (_method: string, params: Record<string, unknown>) =>
      ({
        id: crypto.randomUUID(),
        name: params.name,
        conversationId,
      }) as Artifact,
  );
  let attachments!: ReturnType<typeof useAttachments>;
  function Harness() {
    attachments = useAttachments(conversationId, mutate as Mutate);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  const drop = (files: File[]) =>
    attachments.dragHandlers.onDrop({
      dataTransfer: { types: ['Files'], files },
      preventDefault() {},
    } as unknown as DragEvent);
  return { conversationId, mutate, drop };
}

describe('attachment upload batches', () => {
  it('rejects the entire batch when a later file exceeds the size limit', async () => {
    const { conversationId, mutate, drop } = fixture();
    const existing = { id: 'existing' } as Artifact;
    composerDrafts.edit(conversationId, { content: '保留草稿', attachments: [existing] });
    const saved = composerDrafts.read(conversationId);
    drop([
      new File(['small'], 'first.txt'),
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'large.bin'),
    ]);
    await vi.waitFor(() => expect(composerDrafts.read(conversationId).attaching).toBe(false));
    expect(mutate).not.toHaveBeenCalled();
    expect(composerDrafts.read(conversationId)).toMatchObject({
      content: saved.content,
      attachments: saved.attachments,
      requestId: saved.requestId,
      error: expect.stringContaining('large.bin'),
    });
  });

  it('uploads every valid file in order and keeps the results in the originating draft', async () => {
    const { conversationId, mutate, drop } = fixture();
    drop([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')]);
    await vi.waitFor(() => expect(composerDrafts.read(conversationId).attaching).toBe(false));
    expect(mutate.mock.calls.map(([method, params]) => [method, params.name, params.data])).toEqual(
      [
        ['conversations.attachBytes', 'first.txt', Buffer.from('first').toString('base64')],
        ['conversations.attachBytes', 'second.txt', Buffer.from('second').toString('base64')],
      ],
    );
    expect(
      composerDrafts.read(conversationId).attachments.map((artifact) => artifact.name),
    ).toEqual(['first.txt', 'second.txt']);
    expect(composerDrafts.read(conversationId).error).toBe('');
  });
});
