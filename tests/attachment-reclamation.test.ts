import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { importAttachment } from '../src/core/attachments.js';
import { setup } from './core-harness.js';

describe('attachment reclamation', () => {
  it.each(['renewed', 'sent'] as const)(
    'protects an expired attachment that becomes %s while cleanup is waiting',
    async (action) => {
      const { core, root, bot } = await setup(async () => ({ text: '完成' }));
      bot('Chief');
      core.scheduler.pause();
      const conversationId = core.state.settings().mainConversationId!;
      const source = join(root, 'draft.txt');
      await writeFile(source, 'draft bytes');
      const artifact = await importAttachment(core.state, conversationId, source);
      core.state.storage.setMetadata(`artifact-draft:${artifact.id}`, {
        conversationId,
        touchedAt: Date.now() - 25 * 60 * 60 * 1000,
      });
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const preview = vi.spyOn(core.previews, 'remove').mockImplementation(async () => {
        entered();
        await hold;
      });
      const cleaning = core.files.maintain();
      await ready;
      try {
        if (action === 'renewed')
          core.files.drafts.retain([{ conversationId, artifactIds: [artifact.id] }]);
        else core.tasks.send({ conversationId, content: '处理资料', artifactIds: [artifact.id] });
      } finally {
        release();
        await cleaning;
        preview.mockRestore();
      }
      expect(core.state.storage.get('artifacts', artifact.id)).toBeDefined();
      expect(await readFile(artifact.path, 'utf8')).toBe('draft bytes');
    },
  );
});
