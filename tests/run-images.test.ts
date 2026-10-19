import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { imageResolver } from '../src/core/run-images.js';
import { State } from '../src/core/state.js';
import * as imageTools from '../src/tools/model-images.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

describe('run image resolver', () => {
  let directory: string;
  let state: State;
  let context: ToolExecutionContext;
  let controller: AbortController;
  let png: Buffer;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'multi-ai-run-images-'));
    state = new State(join(directory, 'state'));
    controller = new AbortController();
    context = {
      signal: controller.signal,
      findArtifact: (id) => state.storage.get<Artifact>('artifacts', id),
    } as ToolExecutionContext;
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    vi.mocked(readFile).mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    state.storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function artifact(id = 'image', size = 0, normalized = true) {
    const path = join(directory, `${id}.png`);
    await writeFile(path, size ? Buffer.concat([png, Buffer.alloc(size - png.length)]) : png);
    const value: Artifact = {
      id,
      path,
      name: id,
      conversationId: 'conversation',
      createdAt: '',
      mimeType: 'image/png',
      sha256: id,
      size: size || png.length,
      image: normalized ? { path, mimeType: 'image/png', width: 8, height: 6 } : undefined,
    };
    state.storage.put('artifacts', value);
    return { artifactId: id, mimeType: 'image/png' };
  }
  function reads(path: string) {
    return vi.mocked(readFile).mock.calls.filter((args) => args[0] === path).length;
  }

  it('shares real image reads across concurrent and repeated requests within one run', async () => {
    const image = await artifact();
    const resolve = imageResolver(state, context);
    const results = await Promise.all([resolve(image), resolve(image), resolve(image)]);
    const encoded = results[0].data;
    expect(results.map((result) => result.data)).toEqual([encoded, encoded, encoded]);
    expect(await sharp(Buffer.from(encoded, 'base64')).raw().toBuffer()).toEqual(
      await sharp(png).raw().toBuffer(),
    );
    results[0].data = 'changed by caller';
    expect((await resolve(image)).data).toBe(encoded);
    expect(reads(join(directory, 'image.png'))).toBe(1);
    await imageResolver(state, context)(image);
    expect(reads(join(directory, 'image.png'))).toBe(1);
  });

  it('normalizes a lazy artifact once and persists its real preview metadata', async () => {
    const image = await artifact('lazy', 0, false);
    const resolve = imageResolver(state, context);
    await Promise.all([resolve(image), resolve(image)]);
    await resolve(image);
    const saved = state.storage.get<Artifact>('artifacts', 'lazy')!;
    expect(saved.image).toMatchObject({ width: 8, height: 6, mimeType: 'image/png' });
    expect(reads(saved.path)).toBe(2);
    expect((await sharp(await readFile(saved.image!.path)).metadata()).width).toBe(8);
  });

  it('checks current authorization even on a cache hit and never resurrects a deleted artifact', async () => {
    const image = await artifact();
    const saved = state.storage.get<Artifact>('artifacts', image.artifactId)!;
    const resolve = imageResolver(state, context);
    await resolve(image);
    context.findArtifact = () => undefined;
    await expect(resolve(image)).rejects.toThrow('授权范围');
    context.findArtifact = (id) => state.storage.get<Artifact>('artifacts', id);
    const original = imageTools.resolveModelArtifactImage;
    let release!: () => void;
    let started!: () => void;
    const startedRead = new Promise<void>((done) => {
      started = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const load = vi
      .spyOn(imageTools, 'resolveModelArtifactImage')
      .mockImplementation(async (value) => {
        const result = await original(value);
        started();
        await gate;
        return result;
      });
    const fresh = imageResolver(state, context);
    const work = fresh(image);
    const rejected = expect(work).rejects.toThrow('授权范围');
    await startedRead;
    state.storage.delete('artifacts', saved.id);
    release();
    await rejected;
    expect(state.storage.get('artifacts', saved.id)).toBeUndefined();
    state.storage.put('artifacts', saved);
    await fresh(image);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached model bytes when the actual source changes or disappears', async () => {
    const image = await artifact();
    const resolve = imageResolver(state, context);
    await resolve(image);
    const path = join(directory, 'image.png');
    const changed = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await writeFile(path, changed);
    const result = await resolve(image);
    expect(await sharp(Buffer.from(result.data, 'base64')).raw().toBuffer()).toEqual(
      await sharp(changed).raw().toBuffer(),
    );
    expect(reads(path)).toBe(2);
    await rm(path);
    await expect(resolve(image)).rejects.toThrow();
  });

  it('does not cache failures or return a result after cancellation', async () => {
    const image = await artifact();
    const resolve = imageResolver(state, context);
    const original = imageTools.resolveModelArtifactImage;
    vi.spyOn(imageTools, 'resolveModelArtifactImage')
      .mockRejectedValueOnce(new Error('read failed'))
      .mockImplementationOnce(original);
    await expect(resolve(image)).rejects.toThrow('read failed');
    expect(
      await sharp(Buffer.from((await resolve(image)).data, 'base64'))
        .raw()
        .toBuffer(),
    ).toEqual(await sharp(png).raw().toBuffer());
    controller.abort();
    await expect(resolve(image)).rejects.toThrow();
  });

  it('evicts older encodings to keep the 32 MiB budget and skips oversized encodings', async () => {
    const first = await artifact('first'),
      second = await artifact('second'),
      oversized = await artifact('oversized');
    const load = vi
      .spyOn(imageTools, 'resolveModelArtifactImage')
      .mockImplementation(async (artifact) => ({
        mimeType: 'image/png',
        data: Buffer.alloc((artifact.id === 'oversized' ? 25 : 13) * 1024 * 1024).toString(
          'base64',
        ),
      }));
    const loads = (id: string) => load.mock.calls.filter(([artifact]) => artifact.id === id).length;
    const resolve = imageResolver(state, context);
    await resolve(first);
    await resolve(second);
    await resolve(first);
    expect(loads('first')).toBe(2);
    await resolve(oversized);
    await resolve(oversized);
    expect(loads('oversized')).toBe(2);
    await resolve(first);
    expect(loads('first')).toBe(2);
  });
});
