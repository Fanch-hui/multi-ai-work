import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppUpdater } from '../apps/desktop/app-updater.js';
import { APP_UPDATE_FEED, type AppUpdateAsset } from '../src/domain/app-update.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { invalidHash?: boolean; slow?: boolean; missing?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-updater-'));
  roots.push(root);
  const bytes = Buffer.from('complete application package');
  const asset: AppUpdateAsset = { platform: 'macos', architecture: 'arm64', kind: 'app-zip',
    url: 'https://github.com/Fanch-hui/multi-ai-work/releases/download/v0.6.16/multi-AI-work-0.6.16-arm64.zip',
    sha256: options.invalidHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  let checks = 0, cancelled = false, busy = false, failLaunch = false, downloadedPath = '';
  const actions: string[] = [];
  const updater = new AppUpdater({ version: '0.6.15', enabled: true, platform: 'macos', architecture: 'arm64',
    cacheDirectory: root, changed: () => {},
    fetcher: async input => {
      if (String(input) === APP_UPDATE_FEED) {
        checks++;
        return options.missing ? new Response(null, { status: 404 }) : Response.json({ version: '0.6.16', assets: [asset], notes: 'not exposed' });
      }
      const body = options.slow ? new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes.subarray(0, 8)); }, cancel() { cancelled = true; },
      }) : bytes;
      return new Response(body, { headers: { 'content-length': String(bytes.length) } });
    },
    acquire: async () => { if (busy) throw new Error('请先完成或停止所有任务'); actions.push('acquire'); },
    release: async () => { actions.push('release'); },
    prepareInstallation: async path => {
      downloadedPath = path;
      expect(await readFile(path)).toEqual(bytes);
      actions.push('prepare');
      return { launch: async () => { actions.push('launch'); if (failLaunch) throw new Error('helper failed'); },
        cleanup: async () => { actions.push('cleanup'); } };
    },
    quit: () => { actions.push('quit'); },
  });
  return { updater, root, bytes, actions, checks: () => checks, cancelled: () => cancelled, path: () => downloadedPath,
    setBusy: (value: boolean) => { busy = value; }, failLaunch: () => { failLaunch = true; } };
}

async function downloaded(f: Awaited<ReturnType<typeof fixture>>) {
  await f.updater.start();
  await f.updater.request('app.update.download');
  const [directory] = await readdir(f.root);
  return join(f.root, directory, 'package.zip');
}

describe('desktop app updates', () => {
  it('checks once per process startup and stages a verified file before explicit installation', async () => {
    const f = await fixture();
    await Promise.all([f.updater.start(), f.updater.start()]);
    expect(f.checks()).toBe(1);
    expect(f.updater.snapshot()).toMatchObject({ phase: 'available', currentVersion: '0.6.15', version: '0.6.16' });
    expect(f.updater.snapshot()).not.toHaveProperty('notes');
    await f.updater.request('app.update.download');
    expect(f.updater.snapshot()).toMatchObject({ phase: 'ready', received: f.bytes.length });
    expect(f.actions).toEqual([]);
    await f.updater.request('app.update.install');
    expect(f.actions).toEqual(['acquire', 'prepare', 'launch', 'quit']);
    expect(await readFile(f.path())).toEqual(f.bytes);
    await f.updater.close();
  });

  it('keeps automatic check failures quiet and exposes manual failures', async () => {
    const f = await fixture({ missing: true });
    await f.updater.start();
    expect(f.updater.snapshot()).toMatchObject({ phase: 'idle', error: undefined });
    await f.updater.request('app.update.check');
    expect(f.updater.snapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('尚未发布') });
    await f.updater.close();
  });

  it('removes a corrupt download and never admits an installer', async () => {
    const f = await fixture({ invalidHash: true });
    await f.updater.start();
    await f.updater.request('app.update.download');
    expect(f.updater.snapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('校验失败') });
    expect(await readdir(f.root)).toEqual([]);
    await f.updater.request('app.update.install');
    expect(f.actions).toEqual([]);
    await f.updater.close();
  });

  it('cancels the actual download stream and clears its partial file', async () => {
    const f = await fixture({ slow: true });
    await f.updater.start();
    const pending = f.updater.request('app.update.download');
    await expect.poll(() => f.updater.snapshot().received).toBe(8);
    await f.updater.request('app.update.cancel');
    await pending;
    expect(f.cancelled()).toBe(true);
    expect(f.updater.snapshot().phase).toBe('available');
    expect(await readdir(f.root)).toEqual([]);
    await f.updater.close();
  });

  it('retains a verified package while busy and releases admission after a helper failure', async () => {
    const f = await fixture();
    const path = await downloaded(f);
    f.setBusy(true);
    await f.updater.request('app.update.install');
    expect(f.updater.snapshot()).toMatchObject({ phase: 'ready', error: expect.stringContaining('所有任务') });
    expect(await readFile(path)).toEqual(f.bytes);
    expect(f.actions).toEqual([]);
    f.setBusy(false); f.failLaunch();
    await f.updater.request('app.update.install');
    expect(f.actions).toEqual(['acquire', 'prepare', 'launch', 'cleanup', 'release']);
    expect(f.updater.snapshot()).toMatchObject({ phase: 'ready', error: 'helper failed' });
    await f.updater.close();
  });

  it('rechecks the cached bytes immediately before installation', async () => {
    const f = await fixture();
    const path = await downloaded(f);
    await writeFile(path, Buffer.alloc(f.bytes.length));
    await f.updater.request('app.update.install');
    expect(f.updater.snapshot().phase).toBe('error');
    expect(f.actions).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
    await f.updater.close();
  });
});
