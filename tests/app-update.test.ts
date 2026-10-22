import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppUpdater } from '../apps/desktop/app-updater.js';
import { APP_UPDATE_FEED, type AppUpdateAsset } from '../src/domain/app-update.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: { invalidHash?: boolean; slow?: boolean; missing?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-updater-'));
  roots.push(root);
  const bytes = Buffer.from('complete application package');
  const asset: AppUpdateAsset = {
    platform: 'macos',
    architecture: 'arm64',
    kind: 'app-zip',
    url: 'https://github.com/Fanch-hui/multi-ai-work/releases/download/v0.6.16/multi-AI-work-0.6.16-arm64.zip',
    sha256: options.invalidHash ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  let checks = 0,
    downloads = 0,
    missing = options.missing,
    manifestVersion = '0.6.16',
    cancelled = false,
    busy = false,
    failLaunch = false,
    downloadedPath = '';
  const actions: string[] = [];
  const createUpdater = (version = '0.6.15') =>
    new AppUpdater({
      version,
      enabled: true,
      platform: 'macos',
      architecture: 'arm64',
      cacheDirectory: root,
      changed: () => {},
      fetcher: async (input) => {
        if (String(input) === APP_UPDATE_FEED) {
          checks++;
          return missing
            ? new Response(null, { status: 404 })
            : Response.json({
                version: manifestVersion,
                assets: [{ ...asset, url: asset.url.replaceAll('0.6.16', manifestVersion) }],
                notes: 'not exposed',
              });
        }
        downloads++;
        const body = options.slow
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 8));
              },
              cancel() {
                cancelled = true;
              },
            })
          : bytes;
        return new Response(body, { headers: { 'content-length': String(bytes.length) } });
      },
      acquire: async () => {
        if (busy) throw new Error('请先完成或停止所有任务');
        actions.push('acquire');
      },
      release: async () => {
        actions.push('release');
      },
      prepareInstallation: async (path) => {
        downloadedPath = path;
        expect(await readFile(path)).toEqual(bytes);
        actions.push('prepare');
        return {
          launch: async () => {
            actions.push('launch');
            if (failLaunch) throw new Error('helper failed');
          },
          cleanup: async () => {
            actions.push('cleanup');
          },
        };
      },
      quit: () => {
        actions.push('quit');
      },
    });
  return {
    updater: createUpdater(),
    restart: createUpdater,
    setMissing: (value: boolean) => {
      missing = value;
    },
    setVersion: (value: string) => {
      manifestVersion = value;
    },
    downloads: () => downloads,
    root,
    bytes,
    actions,
    checks: () => checks,
    cancelled: () => cancelled,
    path: () => downloadedPath,
    setBusy: (value: boolean) => {
      busy = value;
    },
    failLaunch: (value = true) => {
      failLaunch = value;
    },
  };
}

async function downloaded(f: Awaited<ReturnType<typeof fixture>>) {
  await f.updater.start();
  await f.updater.request('app.update.download');
  const directory = (await readdir(f.root)).find((name) => name.startsWith('download-'))!;
  return join(f.root, directory, 'package.zip');
}

describe('desktop app updates', () => {
  it('checks once per process startup and stages a verified file before explicit installation', async () => {
    const f = await fixture();
    await Promise.all([f.updater.start(), f.updater.start()]);
    expect(f.checks()).toBe(1);
    expect(f.updater.snapshot()).toMatchObject({
      phase: 'available',
      currentVersion: '0.6.15',
      version: '0.6.16',
    });
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
    expect(f.updater.snapshot()).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('尚未发布'),
    });
    await f.updater.close();
  });

  it('removes a corrupt download and never admits an installer', async () => {
    const f = await fixture({ invalidHash: true });
    await f.updater.start();
    await f.updater.request('app.update.download');
    expect(f.updater.snapshot()).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('校验失败'),
    });
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
    expect(f.updater.snapshot()).toMatchObject({
      phase: 'ready',
      error: expect.stringContaining('所有任务'),
    });
    expect(await readFile(path)).toEqual(f.bytes);
    expect(f.actions).toEqual([]);
    f.setBusy(false);
    f.failLaunch();
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

  it('restores the verified package after restart without a second download', async () => {
    const f = await fixture();
    const path = await downloaded(f);
    await f.updater.close();
    const next = f.restart();
    await next.start();
    expect(f.checks()).toBe(2);
    expect(next.snapshot().phase).toBe('ready');
    await next.request('app.update.download');
    expect(f.downloads()).toBe(1);
    expect(await readFile(path)).toEqual(f.bytes);
    await next.request('app.update.install');
    expect(f.actions).toEqual(['acquire', 'prepare', 'launch', 'quit']);
    await next.close();
  });

  it('keeps a cached candidate through a failed startup check and revalidates after retry', async () => {
    const f = await fixture();
    const path = await downloaded(f);
    await f.updater.close();
    f.setMissing(true);
    const next = f.restart();
    await next.start();
    expect(next.snapshot().phase).toBe('idle');
    await next.request('app.update.install');
    expect(f.actions).toEqual([]);
    await next.close();
    expect(await readFile(path)).toEqual(f.bytes);
    f.setMissing(false);
    const retry = f.restart();
    await retry.start();
    expect(retry.snapshot().phase).toBe('ready');
    expect(f.downloads()).toBe(1);
    await retry.close();
  });

  it('discards a cached candidate when the manifest selects a newer package', async () => {
    const f = await fixture();
    await downloaded(f);
    await f.updater.close();
    f.setVersion('0.6.17');
    const next = f.restart();
    await next.start();
    expect(next.snapshot()).toMatchObject({ phase: 'available', version: '0.6.17' });
    expect(await readdir(f.root)).toEqual([]);
    await next.close();
  });

  it.each(['corrupt', 'missing', 'installed'] as const)(
    'cleans a %s candidate during startup',
    async (condition) => {
      const f = await fixture();
      const path = await downloaded(f);
      await f.updater.close();
      if (condition === 'corrupt') await writeFile(path, Buffer.alloc(f.bytes.length));
      if (condition === 'missing') await rm(path);
      const next = f.restart(condition === 'installed' ? '0.6.16' : '0.6.15');
      await next.start();
      expect(next.snapshot().phase).toBe(condition === 'installed' ? 'idle' : 'available');
      expect(await readdir(f.root)).toEqual([]);
      await next.close();
    },
  );

  it('removes owned partial directories and leaves unrelated entries intact', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'download-a1b2c3'));
    await writeFile(join(f.root, 'download-a1b2c3', 'package.zip'), 'partial');
    await mkdir(join(f.root, 'download-not-owned'));
    await writeFile(join(f.root, 'notes.txt'), 'keep');
    await f.updater.start();
    expect(await readdir(f.root)).toEqual(['download-not-owned', 'notes.txt']);
    await f.updater.close();
  });

  it('rejects escaping metadata and removes symlinks without touching their target', async () => {
    const f = await fixture();
    const path = await downloaded(f);
    await f.updater.close();
    const metadataPath = join(f.root, 'candidate.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, path: '../outside/package.zip' }));
    const external = await mkdtemp(join(tmpdir(), 'multi-ai-updater-target-'));
    roots.push(external);
    await writeFile(join(external, 'keep'), 'untouched');
    await symlink(external, join(f.root, 'download-z9y8x7'), 'junction');
    const next = f.restart();
    await next.start();
    expect(next.snapshot().phase).toBe('available');
    expect(await readdir(f.root)).toEqual([]);
    expect(await readFile(join(external, 'keep'), 'utf8')).toBe('untouched');
    await expect(readFile(path)).rejects.toThrow();
    await next.close();
  });

  it('can retry installation after a helper failure and a process restart', async () => {
    const f = await fixture();
    await downloaded(f);
    f.failLaunch();
    await f.updater.request('app.update.install');
    expect(f.updater.snapshot().phase).toBe('ready');
    await f.updater.close();
    f.failLaunch(false);
    const next = f.restart();
    await next.start();
    await next.request('app.update.install');
    expect(f.actions.slice(-4)).toEqual(['acquire', 'prepare', 'launch', 'quit']);
    expect(f.downloads()).toBe(1);
    await next.close();
  });

  it('protects the source package until the independent installer process exits', async () => {
    const f = await fixture();
    const path = await downloaded(f);
    await f.updater.close();
    const job = join(f.root, 'installer-a1b2c3');
    await mkdir(job);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    await writeFile(join(job, 'process.json'), JSON.stringify({ pid: child.pid }));
    await writeFile(join(job, 'config.json'), JSON.stringify({ packagePath: path }));
    try {
      const next = f.restart('0.6.16');
      await next.start();
      expect(next.snapshot().phase).toBe('idle');
      expect(await readFile(path)).toEqual(f.bytes);
      await next.close();
      expect(await readFile(path)).toEqual(f.bytes);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    const afterInstaller = f.restart('0.6.16');
    await afterInstaller.start();
    expect(await readdir(f.root)).toEqual(['installer-a1b2c3']);
    await afterInstaller.close();
  });

  it.each(['directory', 'package'] as const)(
    'rejects a candidate with a symbolic %s and preserves its destination',
    async (kind) => {
      const f = await fixture();
      const path = await downloaded(f);
      await f.updater.close();
      const external = await mkdtemp(join(tmpdir(), 'multi-ai-updater-target-'));
      roots.push(external);
      const target = join(external, 'package.zip');
      await writeFile(target, f.bytes);
      if (kind === 'directory') {
        await rm(dirname(path), { recursive: true });
        await symlink(external, dirname(path), 'junction');
      } else {
        await rm(path);
        await symlink(target, path, 'file');
      }
      const next = f.restart();
      await next.start();
      expect(next.snapshot().phase).toBe('available');
      expect(await readdir(f.root)).toEqual([]);
      expect(await readFile(target)).toEqual(f.bytes);
      await next.close();
    },
  );

  it('checks the manifest after a failed installation receipt and keeps the retry package', async () => {
    const f = await fixture();
    await downloaded(f);
    await f.updater.close();
    await writeFile(join(f.root, 'install-result.json'), JSON.stringify({ status: 'failed' }));
    const next = f.restart();
    await next.start();
    expect(f.checks()).toBe(2);
    expect(next.snapshot()).toMatchObject({
      phase: 'ready',
      error: expect.stringContaining('上次更新'),
    });
    await next.close();
  });
});
