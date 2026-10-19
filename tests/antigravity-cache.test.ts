import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AntigravityCatalogCache } from '../src/providers/native/antigravity-cache.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-catalog-cache-'));
  folders.push(root);
  const executable = join(root, 'catalog.mjs');
  await writeFile(
    executable,
    `import fs from 'node:fs';
    fs.appendFileSync('calls.txt', 'call\\n');
    fs.writeFileSync('pid.txt', String(process.pid));
    setTimeout(() => {
      if (fs.existsSync('fail.txt')) process.exit(1);
      console.log('model-high\\tModel (High)');
    }, 250);`,
  );
  const calls = async () =>
    (await readFile(join(root, 'calls.txt'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean).length;
  return { root, executable, calls, cache: new AntigravityCatalogCache() };
}

describe('Antigravity catalog shared queries', () => {
  it('shares the actual CLI query and keeps other waiters alive when one cancels', async () => {
    const { root, executable, calls, cache } = await fixture();
    const cancelled = new AbortController();
    const first = cache.read(executable, 1, root, cancelled.signal);
    const rejection = expect(first).rejects.toThrow('first cancelled');
    const second = cache.read(executable, 1, root, AbortSignal.timeout(5000));
    await expect.poll(calls).toBe(1);
    cancelled.abort(new Error('first cancelled'));
    await rejection;
    expect(await second).toEqual([{ id: 'model-high', name: 'Model (High)' }]);
    expect(await calls()).toBe(1);
    expect(await cache.read(executable, 1, root, AbortSignal.timeout(5000))).toEqual(await second);
    expect(await calls()).toBe(1);
  });

  it('stops the CLI only when the last waiter cancels and allows another query', async () => {
    const { root, executable, calls, cache } = await fixture();
    const firstController = new AbortController(),
      secondController = new AbortController();
    const first = expect(cache.read(executable, 1, root, firstController.signal)).rejects.toThrow(
      'cancelled',
    );
    const second = expect(cache.read(executable, 1, root, secondController.signal)).rejects.toThrow(
      'cancelled',
    );
    await expect.poll(calls).toBe(1);
    const pid = Number(await readFile(join(root, 'pid.txt'), 'utf8'));
    firstController.abort(new Error('cancelled'));
    secondController.abort(new Error('cancelled'));
    await Promise.all([first, second]);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    expect(await cache.read(executable, 1, root, AbortSignal.timeout(5000))).toHaveLength(1);
    expect(await calls()).toBe(2);
  });

  it('does not cache a failure and shares concurrent explicit refreshes', async () => {
    const { root, executable, calls, cache } = await fixture();
    await writeFile(join(root, 'fail.txt'), 'fail');
    await expect(cache.read(executable, 1, root, AbortSignal.timeout(5000))).rejects.toThrow(
      '目录读取失败',
    );
    await rm(join(root, 'fail.txt'));
    await cache.read(executable, 1, root, AbortSignal.timeout(5000));
    await Promise.all([
      cache.read(executable, 1, root, AbortSignal.timeout(5000), true),
      cache.read(executable, 1, root, AbortSignal.timeout(5000), true),
    ]);
    expect(await calls()).toBe(3);
  });

  it('rejects an already cancelled caller without starting the CLI', async () => {
    const { root, executable, calls, cache } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(cache.read(executable, 1, root, controller.signal)).rejects.toThrow('cancelled');
    expect(await calls()).toBe(0);
  });
});
