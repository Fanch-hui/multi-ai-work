import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  maintainDerivedCache,
  measureDerivedCache,
  withDerivedCache,
} from '../src/tools/derived-cache.js';

describe('derived cache lifecycle', () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'derived-cache-'));
    root = path.join(directory, 'derived-cache');
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  async function entry(key: string, bytes: number, ageMs = 0) {
    const target = path.join(root, key.repeat(64));
    await withDerivedCache(target, () => writeFile(path.join(target, 'data'), Buffer.alloc(bytes)));
    const lastUsed = new Date(Date.now() - ageMs);
    await utimes(target, lastUsed, lastUsed);
    return target;
  }

  it('collects idle entries and oldest entries above budget, then refreshes use time', async () => {
    await entry('a', 5, 100000);
    await entry('b', 7, 3000);
    const retained = await entry('c', 9, 2000);
    expect(await measureDerivedCache(root)).toBe(21);
    expect(await maintainDerivedCache(root, { idleMs: 10000, budgetBytes: 10 })).toEqual({
      bytes: 9,
      removedBytes: 12,
    });
    expect(await readdir(root)).toEqual([path.basename(retained)]);
    await withDerivedCache(retained, () => readFile(path.join(retained, 'data')));
    expect(await maintainDerivedCache(root, { idleMs: 1000 })).toEqual({
      bytes: 9,
      removedBytes: 0,
    });
  });

  it('protects queued generation and reads while clearing other entries', async () => {
    const target = await entry('a', 11);
    await entry('b', 13);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = withDerivedCache(target, async () => {
      started();
      await gate;
      return readFile(path.join(target, 'data'));
    });
    await ready;
    expect(await measureDerivedCache(root)).toBe(24);
    expect(await maintainDerivedCache(root, { clear: true })).toEqual({
      bytes: 11,
      removedBytes: 13,
    });
    release();
    expect((await reading).length).toBe(11);
    expect(await maintainDerivedCache(root, { clear: true })).toEqual({
      bytes: 0,
      removedBytes: 11,
    });
  });

  it('leaves unrelated paths and symlink targets untouched', async () => {
    await mkdir(root);
    const outside = path.join(directory, 'original');
    await mkdir(outside);
    await writeFile(path.join(outside, 'source'), 'keep');
    await symlink(outside, path.join(root, 'a'.repeat(64)), 'dir');
    await mkdir(path.join(root, 'unmanaged'));
    await writeFile(path.join(root, 'unmanaged', 'data'), 'keep');
    const target = await entry('b', 3);
    await symlink(outside, path.join(target, 'link'), 'dir');
    expect(await measureDerivedCache(root)).toBe(3);
    expect(await maintainDerivedCache(root, { clear: true })).toEqual({
      bytes: 0,
      removedBytes: 3,
    });
    expect(await readFile(path.join(outside, 'source'), 'utf8')).toBe('keep');
    expect(await readFile(path.join(root, 'unmanaged', 'data'), 'utf8')).toBe('keep');
    await expect(withDerivedCache(path.join(root, 'a'.repeat(64)), async () => {})).rejects.toThrow(
      '目录',
    );
  });
});
