import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { importAttachment, importAttachmentBytes } from '../src/core/attachments.js';
import { State } from '../src/core/state.js';
import type { Artifact, Conversation } from '../src/domain/types.js';
import {
  attachmentSizeLimit,
  normalizeArtifactImage,
  resolveArtifactImage,
} from '../src/tools/images.js';

describe('image attachment storage', () => {
  let directory: string;
  let state: State;
  const conversationId = 'image-conversation';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'multi-ai-images-'));
    state = new State(join(directory, 'state'));
    state.storage.put('conversations', {
      id: conversationId,
      name: '图片',
      kind: 'private',
      memberIds: [],
      workspaceId: state.snapshot().workspaces[0].id,
      createdAt: new Date().toISOString(),
    } satisfies Conversation);
  });
  afterEach(async () => {
    state.storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['png', 'jpeg', 'webp', 'gif'] as const)(
    'imports and decodes a real %s image while preserving its original bytes',
    async (format) => {
      const bytes = await sharp({
        create: { width: 32, height: 24, channels: 4, background: '#2050ff' },
      })
        .toFormat(format)
        .toBuffer();
      const filename = join(directory, `原图.${format}`);
      await writeFile(filename, bytes);
      const artifact = await importAttachment(state, conversationId, filename);
      expect(await readFile(artifact.path)).toEqual(bytes);
      expect(artifact.image).toMatchObject({
        width: 32,
        height: 24,
        mimeType: format === 'gif' ? 'image/png' : `image/${format}`,
      });
      const encoded = await resolveArtifactImage(artifact);
      expect((await sharp(Buffer.from(encoded.data, 'base64')).metadata()).width).toBe(32);
      expect(state.storage.get<Artifact>('artifacts', artifact.id)?.image).toEqual(artifact.image);
      expect(JSON.stringify(state.storage.get('artifacts', artifact.id))).not.toContain(
        encoded.data,
      );
    },
  );

  it('normalizes orientation and constrains the model image size', async () => {
    const oriented = await sharp({
      create: { width: 80, height: 40, channels: 3, background: 'red' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const rotated = await importAttachmentBytes(
      state,
      conversationId,
      'rotate.jpg',
      'image/jpeg',
      oriented.toString('base64'),
    );
    expect(rotated.image).toMatchObject({ width: 40, height: 80 });
    const large = await sharp({
      create: { width: 3000, height: 500, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const resized = await importAttachmentBytes(
      state,
      conversationId,
      'large.png',
      'image/png',
      large.toString('base64'),
    );
    expect(resized.image?.width).toBe(2048);
    expect(resized.image?.height).toBeLessThan(500);
    expect(await readFile(resized.path)).toEqual(large);
  });

  it('rejects mismatched signatures and truncated image data without retaining files', async () => {
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .jpeg()
      .toBuffer();
    await expect(
      importAttachmentBytes(
        state,
        conversationId,
        'wrong.png',
        'image/png',
        jpeg.toString('base64'),
      ),
    ).rejects.toThrow('不一致');
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await expect(
      importAttachmentBytes(
        state,
        conversationId,
        'broken.png',
        'image/png',
        png.subarray(0, 50).toString('base64'),
      ),
    ).rejects.toThrow('解码');
    expect(state.storage.all('artifacts')).toEqual([]);
    expect(await readdir(join(state.dataDirectory, 'artifacts'))).toEqual([]);
  });

  it('rejects animated GIFs', async () => {
    const frame = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const animated = Buffer.concat([
      frame.subarray(0, -1),
      frame.subarray(19, -1),
      Buffer.from([0x3b]),
    ]);
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(
      importAttachmentBytes(
        state,
        conversationId,
        'animation.gif',
        'image/gif',
        animated.toString('base64'),
      ),
    ).rejects.toThrow('动画');
  });

  it('rejects oversized files and non-canonical base64 before storing an artifact', async () => {
    const file = join(directory, 'too-large.png');
    await writeFile(file, '');
    await truncate(file, attachmentSizeLimit + 1);
    await expect(importAttachment(state, conversationId, file)).rejects.toThrow('25 MiB');
    for (const data of ['a', 'a===', 'YWJj\n', 'Zh==']) {
      await expect(
        importAttachmentBytes(state, conversationId, 'bad.png', 'image/png', data),
      ).rejects.toThrow('编码');
    }
    expect(state.storage.all('artifacts')).toEqual([]);
  });

  it('sanitizes incoming names and lazily normalizes a registered immutable image', async () => {
    const bytes = await sharp({
      create: { width: 12, height: 8, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();
    const artifact = await importAttachmentBytes(
      state,
      conversationId,
      '..\\outside\\.model-image.png',
      'image/png',
      bytes.toString('base64'),
    );
    expect(artifact.name).toBe('.model-image.png');
    expect(await readFile(artifact.path)).toEqual(bytes);
    const registered = { ...artifact, image: undefined };
    await normalizeArtifactImage(registered);
    expect(registered.image).toMatchObject({ width: 12, height: 8 });
    expect(await readFile(artifact.path)).toEqual(bytes);
  });

  it('keeps PPTX and existing text attachment imports available', async () => {
    const pptx = await importAttachmentBytes(
      state,
      conversationId,
      'slides.pptx',
      '',
      Buffer.from('office-container').toString('base64'),
    );
    expect(pptx.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(pptx.image).toBeUndefined();
    const text = await importAttachmentBytes(state, conversationId, 'empty.txt', 'text/plain', '');
    expect(text.size).toBe(0);
    await expect(
      importAttachmentBytes(state, 'missing-conversation', 'image.png', 'image/png', ''),
    ).rejects.toThrow('对话不存在');
  });
});
