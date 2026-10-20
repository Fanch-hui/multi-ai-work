import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import { maintainDerivedCache } from '../src/tools/derived-cache.js';
import { normalizeArtifactImage } from '../src/tools/images.js';
import {
  MODEL_IMAGE_ENCODING_VERSION,
  resolveModelArtifactImage,
} from '../src/tools/model-images.js';

describe('model image derivatives', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'multi-ai-model-images-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function artifact(bytes: Buffer, mimeType = 'image/png'): Promise<Artifact> {
    const path = join(directory, 'original');
    await writeFile(path, bytes);
    return {
      id: 'image',
      name: 'image',
      path,
      mimeType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      conversationId: 'conversation',
      createdAt: new Date().toISOString(),
    };
  }

  it('preserves document pixels, transparency, the original and the existing preview', async () => {
    const width = 320;
    const height = 240;
    const pixels = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (x % 13 === 0 || y % 19 === 0) pixels.fill(0, i, i + 3);
        if (x < 20) pixels[i + 3] = 96;
      }
    const original = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const value = await artifact(original);
    await normalizeArtifactImage(value);
    const preview = await readFile(value.image!.path);
    const before = structuredClone(value);
    const result = await resolveModelArtifactImage(value);
    const output = Buffer.from(result.data, 'base64');
    expect(result.mimeType).toBe('image/png');
    expect(await sharp(output).raw().toBuffer()).toEqual(pixels);
    expect(output.length).toBeLessThan(original.length / 4);
    expect(await readFile(value.path)).toEqual(original);
    expect(await readFile(value.image!.path)).toEqual(preview);
    expect(value).toEqual(before);
  });

  it.each(['jpeg', 'webp'] as const)(
    'uses a smaller %s model copy without enlarging a photo',
    async (format) => {
      const width = 1200;
      const height = 800;
      const pixels = Buffer.alloc(width * height * 3);
      let seed = 17;
      for (let i = 0; i < pixels.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[i] = (i / 1200 + (seed >>> 27) * 5) % 256;
      }
      const original = await sharp(pixels, { raw: { width, height, channels: 3 } })
        .toFormat(format, { quality: 98 })
        .toBuffer();
      const value = await artifact(original, `image/${format}`);
      await normalizeArtifactImage(value);
      const preview = await readFile(value.image!.path);
      const output = Buffer.from((await resolveModelArtifactImage(value)).data, 'base64');
      expect(output.length).toBeLessThan(preview.length);
      expect(await sharp(output).metadata()).toMatchObject({ format, width, height });
      expect(await readFile(value.path)).toEqual(original);
      expect(await readFile(value.image!.path)).toEqual(preview);
    },
    15_000,
  );

  it('applies orientation and the maximum edge while leaving small images at their original size', async () => {
    const bytes = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#147cab' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const value = await artifact(bytes, 'image/jpeg');
    const output = Buffer.from((await resolveModelArtifactImage(value)).data, 'base64');
    expect(await sharp(output).metadata()).toMatchObject({ width: 683, height: 2048 });
    expect(await readFile(value.path)).toEqual(bytes);
  });

  it('strips EXIF and orientation metadata from a model copy while retaining the original metadata', async () => {
    const pixels = Buffer.from(
      Array.from({ length: 160 * 120 * 3 }, (_, i) => (Math.imul(i, 17) ^ (i >>> 4)) & 255),
    );
    const bytes = await sharp(pixels, { raw: { width: 160, height: 120, channels: 3 } })
      .jpeg({ quality: 1 })
      .withMetadata({ orientation: 1, exif: { IFD0: { Artist: 'Source image metadata' } } })
      .toBuffer();
    const originalMetadata = await sharp(bytes).metadata();
    expect(originalMetadata.exif).toBeDefined();
    expect(originalMetadata.orientation).toBe(1);
    const value = await artifact(bytes, 'image/jpeg');
    const output = Buffer.from((await resolveModelArtifactImage(value)).data, 'base64');
    const modelMetadata = await sharp(output).metadata();
    expect(output.length).toBeGreaterThan(bytes.length);
    expect(modelMetadata).toMatchObject({ width: 160, height: 120 });
    expect(modelMetadata.exif).toBeUndefined();
    expect(modelMetadata.orientation).toBeUndefined();
    expect(modelMetadata.icc).toBeUndefined();
    expect(await readFile(value.path)).toEqual(bytes);
  });

  it('reuses one durable derivative across concurrent calls and fresh artifact objects, and invalidates changed sources', async () => {
    const png = await sharp({
      create: { width: 8, height: 6, channels: 4, background: '#2e9f7a80' },
    })
      .png()
      .toBuffer();
    const value = await artifact(png);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveModelArtifactImage({ ...value })),
    );
    expect(results.every((result) => result.data === results[0].data)).toBe(true);
    const cacheDirectory = join(dirname(value.path), `${value.id}-preview`, '.image');
    const names = await readdir(cacheDirectory);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(`input-v${MODEL_IMAGE_ENCODING_VERSION}-`);
    const cache = join(cacheDirectory, names[0]);
    const first = await stat(cache, { bigint: true });
    expect(await resolveModelArtifactImage(structuredClone(value))).toEqual(results[0]);
    const second = await stat(cache, { bigint: true });
    expect(second.mtimeNs).toBe(first.mtimeNs);
    expect(second.ino).toBe(first.ino);
    const replacement = await sharp({
      create: { width: 8, height: 6, channels: 4, background: '#ff000080' },
    })
      .png()
      .toBuffer();
    await writeFile(value.path, replacement);
    const changed = await resolveModelArtifactImage(value);
    expect(changed.data).not.toBe(results[0].data);
    expect(await sharp(Buffer.from(changed.data, 'base64')).raw().toBuffer()).toEqual(
      await sharp(replacement).raw().toBuffer(),
    );
    expect((await readdir(cacheDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not retain a failed generation and can retry a repaired source', async () => {
    const value = await artifact(Buffer.from('invalid image'));
    await expect(resolveModelArtifactImage(value)).rejects.toThrow('不一致');
    const repaired = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#112233' },
    })
      .png()
      .toBuffer();
    await writeFile(value.path, repaired);
    const output = Buffer.from((await resolveModelArtifactImage(value)).data, 'base64');
    expect(await sharp(output).metadata()).toMatchObject({ width: 3, height: 2 });
  });
  it('shares content-addressed previews and model copies, rebuilds collected files and checks each source', async () => {
    const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const first = await artifact(png);
    const second = { ...first, id: 'second', path: join(directory, 'second.png') };
    await writeFile(second.path, png);
    const dataDirectory = join(directory, 'data');
    const images = await Promise.all([
      normalizeArtifactImage(first, dataDirectory),
      normalizeArtifactImage(second, dataDirectory),
    ]);
    expect(images[0].path).toBe(images[1].path);
    const results = await Promise.all([
      resolveModelArtifactImage(first, dataDirectory),
      resolveModelArtifactImage(second, dataDirectory),
    ]);
    expect(results[0]).toEqual(results[1]);
    const root = join(dataDirectory, 'derived-cache');
    expect(await readdir(root)).toHaveLength(2);
    await maintainDerivedCache(root, { clear: true });
    expect(await resolveModelArtifactImage(first, dataDirectory)).toEqual(results[0]);
    expect(await normalizeArtifactImage(first, dataDirectory)).toEqual(images[0]);
    await rm(second.path);
    await expect(resolveModelArtifactImage(second, dataDirectory)).rejects.toThrow();
    await expect(normalizeArtifactImage(second, dataDirectory)).rejects.toThrow();
    expect(await readFile(first.path)).toEqual(png);
  });
});
