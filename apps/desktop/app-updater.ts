import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APP_UPDATE_FEED,
  type AppUpdateState,
  type AppUpdateAsset,
} from '../../src/domain/app-update.js';
import { selectUpdate } from '../../src/updates/manifest.js';
import {
  downloadUpdate,
  readUpdateManifest,
  verifyUpdateFile,
  type UpdateFetch,
} from '../../src/updates/download.js';

type PreparedInstaller = { launch(): Promise<void>; cleanup(): Promise<void> };
interface Options {
  version: string;
  enabled: boolean;
  platform: AppUpdateAsset['platform'];
  architecture: AppUpdateAsset['architecture'];
  cacheDirectory: string;
  fetcher: UpdateFetch;
  prepareInstallation(path: string, version: string): Promise<PreparedInstaller>;
  acquire(): Promise<unknown>;
  release(): Promise<unknown>;
  quit(): void;
  changed(state: AppUpdateState): void;
}

export class AppUpdater {
  private state: AppUpdateState;
  private selected?: NonNullable<ReturnType<typeof selectUpdate>>;
  private controller?: AbortController;
  private operation?: Promise<AppUpdateState>;
  private directory?: string;
  private packagePath?: string;
  private started = false;
  private closed = false;
  constructor(private options: Options) {
    this.state = { phase: options.enabled ? 'idle' : 'disabled', currentVersion: options.version };
  }
  snapshot() {
    return { ...this.state };
  }
  private change(next: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...next };
    if (!this.closed) this.options.changed(this.snapshot());
  }
  async start() {
    if (this.started || this.state.phase === 'disabled') return;
    this.started = true;
    this.operation = this.initialize()
      .catch(() => this.snapshot())
      .finally(() => {
        this.operation = undefined;
      });
    await this.operation;
  }
  private async initialize(): Promise<AppUpdateState> {
    await mkdir(this.options.cacheDirectory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.options.cacheDirectory)) {
      if (name.startsWith('download-'))
        await rm(join(this.options.cacheDirectory, name), { recursive: true, force: true }).catch(
          () => {},
        );
    }
    const receipt = join(this.options.cacheDirectory, 'install-result.json');
    try {
      const result = JSON.parse(await readFile(receipt, 'utf8')) as { status?: string };
      await rm(receipt, { force: true });
      if (result.status === 'failed') {
        this.change({ phase: 'error', error: '上次更新未完成，请重新检查更新后重试' });
        return this.snapshot();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rm(receipt, { force: true });
    }
    return this.check(true);
  }
  request(method: string): Promise<AppUpdateState> {
    if (method === 'app.update.state') return Promise.resolve(this.snapshot());
    if (
      ![
        'app.update.check',
        'app.update.download',
        'app.update.cancel',
        'app.update.install',
      ].includes(method)
    )
      return Promise.reject(new Error('不支持的更新操作'));
    if (this.state.phase === 'disabled') return Promise.resolve(this.snapshot());
    if (method === 'app.update.cancel') {
      this.cancel();
      return Promise.resolve(this.snapshot());
    }
    if (this.operation) return this.operation;
    let action: Promise<AppUpdateState>;
    if (method === 'app.update.check') action = this.check();
    else if (method === 'app.update.download') action = this.download();
    else if (method === 'app.update.install') action = this.install();
    else return Promise.reject(new Error('不支持的更新操作'));
    this.operation = action.finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async clearDownload() {
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.packagePath = undefined;
  }
  private async check(automatic = false) {
    if (['downloading', 'installing'].includes(this.state.phase)) return this.snapshot();
    this.controller = new AbortController();
    this.change({ phase: 'checking', error: undefined });
    try {
      const manifest = await readUpdateManifest(
        APP_UPDATE_FEED,
        this.options.fetcher,
        this.controller.signal,
      );
      if (this.closed) return this.snapshot();
      let selected: typeof this.selected;
      try {
        selected = selectUpdate(
          manifest,
          this.options.version,
          this.options.platform,
          this.options.architecture,
        );
      } catch {
        throw new Error('更新清单无效或缺少当前平台安装包');
      }
      const same =
        selected &&
        this.selected?.asset.sha256 === selected.asset.sha256 &&
        this.selected.version === selected.version;
      if (!same) await this.clearDownload();
      this.selected = selected;
      const resolvePhase = () => {
        if (selected) {
          if (this.packagePath) {
            return 'ready';
          }
          return 'available';
        }
        return 'idle';
      };
      this.change({
        phase: resolvePhase(),
        version: selected?.version,
        total: selected?.asset.size,
        received: this.packagePath ? selected?.asset.size : 0,
        error: undefined,
      });
    } catch (error) {
      if (!this.closed)
        this.change({
          phase: automatic ? 'idle' : 'error',
          error: automatic ? undefined : this.message(error),
        });
    } finally {
      this.controller = undefined;
    }
    return this.snapshot();
  }
  private async download() {
    if (!this.selected || this.packagePath) return this.snapshot();
    await this.clearDownload();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.change({
      phase: 'downloading',
      received: 0,
      total: this.selected.asset.size,
      error: undefined,
    });
    try {
      await mkdir(this.options.cacheDirectory, { recursive: true, mode: 0o700 });
      this.directory = await mkdtemp(join(this.options.cacheDirectory, 'download-'));
      const path = join(
        this.directory,
        this.selected.asset.kind === 'app-zip' ? 'package.zip' : 'package.exe',
      );
      let last = 0;
      await downloadUpdate(this.selected.asset, path, this.options.fetcher, signal, (received) => {
        if (Date.now() - last < 200) return;
        last = Date.now();
        this.change({ received });
      });
      signal.throwIfAborted();
      this.packagePath = path;
      this.change({ phase: 'ready', received: this.selected.asset.size, error: undefined });
    } catch (error) {
      await this.clearDownload();
      this.change({
        phase: signal.aborted ? 'available' : 'error',
        received: 0,
        error: signal.aborted ? undefined : this.message(error),
      });
    } finally {
      this.controller = undefined;
    }
    return this.snapshot();
  }
  private async install() {
    if (!this.packagePath || !this.selected || this.state.phase === 'installing')
      return this.snapshot();
    let installer: PreparedInstaller | undefined,
      acquired = false,
      verified = false;
    this.change({ phase: 'installing', error: undefined });
    try {
      await verifyUpdateFile(this.packagePath, this.selected.asset);
      verified = true;
      await this.options.acquire();
      acquired = true;
      installer = await this.options.prepareInstallation(this.packagePath, this.selected.version);
      await installer.launch();
      this.options.quit();
    } catch (error) {
      await installer?.cleanup().catch(() => {});
      if (acquired) await this.options.release().catch(() => {});
      if (
        this.packagePath &&
        !(await lstat(this.packagePath).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        verified = false;
      if (!verified) await this.clearDownload();
      this.change({ phase: verified ? 'ready' : 'error', error: this.message(error) });
    }
    return this.snapshot();
  }
  private cancel() {
    if (this.state.phase === 'downloading' || this.state.phase === 'checking')
      this.controller?.abort();
  }
  async close() {
    this.closed = true;
    if (this.state.phase !== 'installing') this.controller?.abort();
    await this.operation;
    if (this.state.phase !== 'installing') await this.clearDownload();
  }
  private message(error: unknown) {
    return error instanceof Error && error.name !== 'AbortError'
      ? error.message
      : '更新操作已取消，请重试';
  }
}
