import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { MarketState, PresetInstallation } from '../../domain/market.js';
import { professions } from '../../domain/market.js';
import type { Bot, Skill } from '../../domain/types.js';
import type { State } from '../state.js';
import { now } from '../state.js';
import type { EntityService } from '../entities.js';
import { required, publicError } from '../errors.js';
import { MarketCatalog } from './catalog.js';
import { PresetMembers } from './members.js';
import { installPresetArchive, installationId } from './package.js';
import { fetchMarketBytes } from './network.js';

export class MarketService {
  readonly catalog: MarketCatalog;
  private members: PresetMembers;
  private downloads = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private fetching?: Promise<MarketState>;
  private catalogController?: AbortController;
  constructor(private state: State, entities: EntityService, catalogUrl?: string) {
    this.catalog = new MarketCatalog(state, catalogUrl); this.members = new PresetMembers(state, entities);
    for (const item of this.installations()) {
      if (item.status === 'downloading') this.save({ ...item, status: 'failed', error: '上次下载未完成，请重试' });
      else if (item.status === 'installed' && (!item.directory || !existsSync(item.directory)))
        this.save({ ...item, status: 'missing', error: '预设资源缺失，请重新下载或导入' });
    }
  }
  private installations() { return this.state.storage.all<PresetInstallation>('preset_installations'); }
  private save(item: PresetInstallation) { this.state.storage.put('preset_installations', item); return item; }
  list(): MarketState {
    return { professions, presets: this.catalog.list(), installations: this.installations(),
      preferences: this.catalog.preferences(), catalogConfigured: !!this.catalog.url,
      refreshedAt: this.state.storage.metadata<string>('market.refreshedAt') };
  }
  private serialize<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('市场正在停止，请稍后重试'));
    const operation = this.queue.catch(() => undefined).then(action);
    this.queue = operation; return operation;
  }
  async refresh(): Promise<MarketState> {
    if (this.stopping) throw new Error('市场正在停止');
    if (this.fetching) return this.fetching;
    this.catalogController = new AbortController();
    this.fetching = this.catalog.refresh(this.catalogController.signal).then(() => this.list());
    try { return await this.fetching; }
    finally { this.fetching = undefined; this.catalogController = undefined; }
  }
  download(presetId: string): PresetInstallation {
    if (this.stopping) throw new Error('市场正在停止');
    const preset = required(this.catalog.list().find(item => item.id === presetId), '预设不在官方目录中');
    if (!preset.download) throw new Error('此预设尚未发布下载包');
    const id = installationId('official', preset.id, preset.version);
    const old = this.state.storage.get<PresetInstallation>('preset_installations', id);
    if (old?.status === 'installed' || this.downloads.has(id)) return required(old, '下载记录不存在');
    const item: PresetInstallation = { id, preset, source: 'official', status: 'downloading', progress: 0,
      skillIds: [], createdAt: old?.createdAt ?? now() };
    this.save(item);
    const controller = new AbortController();
    const done = this.performDownload(item, controller.signal).catch(error => {
      this.save({ ...item, status: controller.signal.aborted ? 'cancelled' : 'failed', progress: 0, error: publicError(error) });
    }).finally(() => this.downloads.delete(id));
    this.downloads.set(id, { controller, done }); return item;
  }
  private async performDownload(item: PresetInstallation, signal: AbortSignal) {
    const download = item.preset.download!;
    const bytes = await fetchMarketBytes(download.url, { signal, maximum: Math.min(download.bytes, 256 * 1024 * 1024),
      progress: (received) => {
        const progress = Math.min(90, Math.floor(received / download.bytes * 90));
        if (progress > item.progress) { item.progress = progress; this.save({ ...item }); }
      } });
    signal.throwIfAborted();
    if (bytes.length !== download.bytes || createHash('sha256').update(bytes).digest('hex') !== download.sha256)
      throw new Error('下载包大小或摘要与目录不一致');
    const parent = join(this.state.dataDirectory, 'market-downloads'); await mkdir(parent, { recursive: true });
    const temporary = await mkdtemp(join(parent, 'download-'));
    try {
      const path = join(temporary, 'preset.zip'); await writeFile(path, bytes);
      await this.serialize(async () => {
        signal.throwIfAborted();
        await installPresetArchive(this.state, path, 'official', item.preset, { signal });
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async cancel(id: string) {
    const operation = this.downloads.get(id);
    if (operation) { operation.controller.abort(); await operation.done; }
    return this.state.storage.get<PresetInstallation>('preset_installations', id);
  }
  import(path: string) {
    if (!isAbsolute(path)) throw new Error('请选择本地预设 ZIP 文件的绝对路径');
    return this.serialize(() => installPresetArchive(this.state, path, 'local'));
  }
  remove(id: string) {
    if (this.downloads.has(id)) throw new Error('请先取消下载');
    return this.serialize(async () => {
      const s = this.state.storage, item = required(s.get<PresetInstallation>('preset_installations', id), '预设不存在');
      const bots = s.all<Bot>('bots');
      const other = this.installations().filter(other => other.id !== id);
      const unused = item.skillIds.filter(skillId => !other.some(other => other.skillIds.includes(skillId)));
      if (bots.some(bot => bot.preset?.installationId === id || bot.skillIds.some(skill => unused.includes(skill))))
        throw new Error('预设资源仍被成员引用，请先调整成员技能；归档成员仍保留引用');
      const directories = [item.directory, ...unused.map(id => s.get<Skill>('skills', id)?.resourceRoot)].filter((value): value is string => !!value);
      // Remove references synchronously so a concurrent member save cannot bind resources being deleted.
      s.transaction(() => { for (const skillId of unused) s.delete('skills', skillId); s.delete('preset_installations', id); });
      this.state.changed();
      for (const directory of directories) await this.removeOwnedDirectory(directory);
      return { removed: true };
    });
  }
  private async removeOwnedDirectory(directory: string) {
    const path = relative(this.state.dataDirectory, directory);
    if (isAbsolute(path) || path.startsWith('..') || path.split(/[\\/]/).length < 2 || !['skills', 'presets', 'restored'].includes(path.split(/[\\/]/)[0]))
      throw new Error('资源目录不属于应用');
    await rm(directory, { recursive: true, force: true });
  }
  async request(method: string, params: Record<string, unknown>) {
    switch (method) {
      case 'market.list': return this.list();
      case 'market.refresh': return this.refresh();
      case 'career.save': return this.catalog.savePreferences(params);
      case 'market.download': return this.download(z.string().parse(params.presetId));
      case 'market.cancel': return this.cancel(z.string().parse(params.id));
      case 'market.import': return this.import(z.string().parse(params.path));
      case 'market.remove': return this.remove(z.string().parse(params.id));
      case 'market.members.create': return this.serialize(() => this.members.createMany(params.items));
      case 'market.update': return this.serialize(() => this.members.update(z.string().parse(params.installationId),
        z.array(z.string()).min(1).max(50).parse(params.botIds)));
      case 'market.detach': return this.serialize(() => this.members.detach(z.string().parse(params.botId)));
      default: throw new Error('未知市场操作');
    }
  }
  async quiesce() {
    this.stopping = true; this.catalogController?.abort();
    for (const item of this.downloads.values()) item.controller.abort();
    await Promise.allSettled([...this.downloads.values()].map(item => item.done));
    await this.fetching?.catch(() => {}); await this.queue.catch(() => {});
  }
  resume() { this.stopping = false; }
}
