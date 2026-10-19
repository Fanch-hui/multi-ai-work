import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import { ATTACHMENT_LIMIT_MESSAGE } from '../src/domain/attachment-policy.js';
import { setup } from './core-harness.js';

describe('user attachment limits', () => {
  it('imports ten selected files and rejects further selection when the draft is full', async () => {
    let paths: string[] = [],
      selections = 0;
    const { core, root } = await setup(
      async () => ({ text: '完成' }),
      async () => {
        selections++;
        return { paths };
      },
    );
    core.scheduler.pause();
    const conversationId = core.state.settings().mainConversationId!;
    paths = Array.from({ length: 10 }, (_, index) => join(root, `资料${index}.txt`));
    await Promise.all(paths.map((path) => writeFile(path, '资料内容')));
    const result = (await core.request('conversations.attach', {
      conversationId,
      attachmentCount: 0,
    })) as { artifacts: Artifact[] };
    expect(result.artifacts).toHaveLength(10);
    expect(core.state.storage.all('artifacts')).toHaveLength(10);
    await expect(
      core.request('conversations.attach', { conversationId, attachmentCount: 10 }),
    ).rejects.toThrow(ATTACHMENT_LIMIT_MESSAGE);
    expect(selections).toBe(1);
  });

  it.each([
    { existing: 0, selected: 11 },
    { existing: 9, selected: 2 },
  ])(
    'rejects the whole selection of $selected files when the draft already has $existing',
    async ({ existing, selected }) => {
      let paths: string[] = [];
      const { core, root } = await setup(
        async () => ({ text: '完成' }),
        async () => ({ paths }),
      );
      core.scheduler.pause();
      paths = Array.from({ length: selected }, (_, index) => join(root, `资料${index}.txt`));
      await Promise.all(paths.map((path) => writeFile(path, '资料内容')));
      await expect(
        core.request('conversations.attach', {
          conversationId: core.state.settings().mainConversationId!,
          attachmentCount: existing,
        }),
      ).rejects.toThrow(ATTACHMENT_LIMIT_MESSAGE);
      expect(core.state.storage.all('artifacts')).toEqual([]);
    },
  );

  it('accepts ten files in a message and rejects eleven at the Core send boundary', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', memoryMode: 'off' },
    });
    const conversationId = core.state.settings().mainConversationId!;
    const artifacts: Artifact[] = [];
    for (let index = 0; index < 11; index++) {
      const { artifact } = (await core.request('conversations.attachBytes', {
        conversationId,
        name: `资料${index}.txt`,
        mimeType: 'text/plain',
        data: Buffer.from('资料内容').toString('base64'),
      })) as { artifact: Artifact };
      artifacts.push(artifact);
    }
    const artifactIds = artifacts.map((item) => item.id);
    const sent = (await core.request('conversations.send', {
      conversationId,
      content: '',
      artifactIds: artifactIds.slice(0, 10),
    })) as { messageId: string };
    expect(core.state.storage.getMessage(sent.messageId)?.artifactIds).toHaveLength(10);
    await expect(
      core.request('conversations.send', { conversationId, content: '', artifactIds }),
    ).rejects.toThrow(ATTACHMENT_LIMIT_MESSAGE);
    expect(() => core.tasks.send({ conversationId, content: '', artifactIds })).toThrow(
      ATTACHMENT_LIMIT_MESSAGE,
    );
    expect(core.state.storage.messages(conversationId)).toHaveLength(1);
  });
});
