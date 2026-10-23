import { createHash, randomUUID } from 'node:crypto';
import { WebContentsView, session, type BrowserWindow, type WebPreferences } from 'electron';
import type {
  BrowserHostInput,
  BrowserHostMethod,
  BrowserTab,
} from '../../src/domain/work-browser.js';
import { WorkBrowserPage } from './work-browser-page.js';
import { WorkBrowserDownloads } from './work-browser-downloads.js';
import { WorkBrowserPreview } from './work-browser-preview.js';

interface WorkTab {
  id: string;
  view: WebContentsView;
  page: WorkBrowserPage;
}

interface WorkSession {
  id: string;
  profileId: string;
  tabs: WorkTab[];
  active: string;
  interactive: boolean;
  downloads: WorkBrowserDownloads;
  preview: WorkBrowserPreview;
  busy: boolean;
}

export function browserUrl(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('工作浏览器只允许 HTTP 或 HTTPS 网页');
  return url.href;
}

export class WorkBrowserHost {
  private sessions = new Map<string, WorkSession>();

  constructor(private window?: BrowserWindow) {}

  async request(method: BrowserHostMethod, input: BrowserHostInput): Promise<unknown> {
    if (method === 'browser.open') return this.open(input);
    if (method === 'browser.close') {
      this.close(input.sessionId);
      return { ok: true };
    }
    const current = this.sessions.get(input.sessionId);
    if (!current) throw new Error('工作浏览器会话已关闭，请重新打开');
    if (method === 'browser.present') return this.present(current, input);
    if (method === 'browser.interactive') {
      if (current.busy) throw new Error('浏览器操作正在结束，请稍后接管');
      current.interactive = input.interactive === true;
      current.tabs.forEach((tab) => tab.page.handoff());
      this.showActive(current);
      return { ok: true };
    }
    if (current.interactive && method !== 'browser.tabs')
      throw new Error('浏览器已交给用户操作，交回后再继续');
    if (current.busy) throw new Error('浏览器正在执行操作，请稍候');
    current.busy = true;
    try {
      const tab = this.tab(current, input.tabId ?? input.action?.tabId);
      if (method === 'browser.snapshot') return await tab.page.snapshot(tab.id, input.screenshot);
      if (method === 'browser.action') {
        if (!input.action) throw new Error('缺少页面操作');
        return await tab.page.action(input.action);
      }
      if (method === 'browser.tabs') return this.tabs(current, input);
      if (method === 'browser.downloads') return current.downloads.list();
      throw new Error('不支持的浏览器操作');
    } finally {
      current.busy = false;
    }
  }

  closeAll() {
    for (const id of this.sessions.keys()) this.close(id);
  }

  private async open(input: BrowserHostInput) {
    const url = browserUrl(input.url ?? 'https://example.com');
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      if (existing.profileId !== input.profileId) throw new Error('浏览器会话配置不一致');
      if (!input.url) return { sessionId: existing.id, tabs: this.describe(existing) };
      if (existing.interactive || existing.busy) throw new Error('浏览器正在使用，请稍后打开页面');
      existing.busy = true;
      try {
        await this.tab(existing).view.webContents.loadURL(url);
        return { sessionId: existing.id, tabs: this.describe(existing) };
      } finally {
        existing.busy = false;
      }
    }
    if (!input.profileId || !input.sessionId || !input.downloadDirectory)
      throw new Error('浏览器配置、会话和下载目录必须由 Core 提供');
    if ([...this.sessions.values()].some((item) => item.profileId === input.profileId))
      throw new Error('此浏览器配置正在被其他任务使用');
    const partition = `persist:work-browser-${createHash('sha256').update(input.profileId).digest('hex')}`;
    const isolated = session.fromPartition(partition);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const downloads = new WorkBrowserDownloads(isolated);
    const current: WorkSession = {
      id: input.sessionId,
      profileId: input.profileId,
      tabs: [],
      active: '',
      interactive: false,
      preview: new WorkBrowserPreview(this.window),
      downloads,
      busy: true,
    };
    this.sessions.set(current.id, current);
    try {
      await downloads.configure(input.downloadDirectory);
      if (this.sessions.get(current.id) !== current) throw new Error('浏览器会话已关闭');
      const tab = this.createTab(current, partition);
      await tab.view.webContents.loadURL(url);
      if (this.sessions.get(current.id) !== current) throw new Error('浏览器会话已关闭');
      return { sessionId: current.id, tabs: this.describe(current) };
    } catch (error) {
      this.close(current.id);
      throw error;
    } finally {
      current.busy = false;
    }
  }

  private createTab(current: WorkSession, partition: string, inherited?: WebPreferences): WorkTab {
    const webPreferences: WebPreferences = {
      ...inherited,
      partition,
      session: session.fromPartition(partition),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    };
    delete webPreferences.preload;
    const view = new WebContentsView({ webPreferences });
    const contents = view.webContents;
    const tab = { id: randomUUID(), view, page: new WorkBrowserPage(contents) };
    current.tabs.push(tab);
    current.active ||= tab.id;
    current.downloads.add(contents);
    contents.on('render-process-gone', () => {
      current.interactive = false;
    });
    contents.once('destroyed', () => {
      current.tabs = current.tabs.filter((item) => item !== tab);
      if (current.active === tab.id) current.active = current.tabs[0]?.id ?? '';
      this.showActive(current);
    });
    const preventUnsafe = (event: Electron.Event, url: string) => {
      try {
        browserUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    contents.on('will-navigate', preventUnsafe);
    contents.on('will-redirect', preventUnsafe);
    contents.on('will-frame-navigate', (event) => preventUnsafe(event, event.url));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('focus', () => {
      if (!current.interactive && this.window && !this.window.isDestroyed())
        this.window.webContents.focus();
    });
    contents.setWindowOpenHandler(({ url }) => {
      try {
        if (url && url !== 'about:blank') browserUrl(url);
        if (!this.sessions.has(current.id) || current.tabs.length >= 10) return { action: 'deny' };
        return {
          action: 'allow',
          createWindow: (options) => {
            // Electron's preferences contain the opener relationship and native window.open state.
            const popup = this.createTab(current, partition, options.webPreferences);
            current.active = popup.id;
            this.showActive(current);
            return popup.view.webContents;
          },
        };
      } catch {
        return { action: 'deny' };
      }
    });
    view.setVisible(false);
    return tab;
  }

  private tab(current: WorkSession, id = current.active) {
    const tab = current.tabs.find((item) => item.id === id);
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('浏览器标签已关闭');
    return tab;
  }

  private describe(current: WorkSession): BrowserTab[] {
    return current.tabs.map((tab) => ({
      id: tab.id,
      title: tab.view.webContents.getTitle(),
      url: tab.view.webContents.getURL(),
      active: tab.id === current.active,
    }));
  }

  private tabs(current: WorkSession, input: BrowserHostInput) {
    if (input.operation === 'select') {
      const selected = this.tab(current, input.tabId);
      current.active = selected.id;
      this.showActive(current);
    }
    if (input.operation === 'close') {
      if (current.tabs.length === 1) throw new Error('请关闭整个浏览器会话');
      this.removeTab(current, this.tab(current, input.tabId));
    }
    return this.describe(current);
  }

  private async present(current: WorkSession, input: BrowserHostInput) {
    if (input.visible) {
      for (const other of this.sessions.values()) {
        if (other === current) continue;
        other.preview.visible = false;
        this.showActive(other);
      }
    }
    return current.preview.present(input, current.tabs, current.active, current.interactive);
  }

  private showActive(current: WorkSession) {
    current.preview.render(current.tabs, current.active, current.interactive);
  }

  private removeTab(current: WorkSession, tab: WorkTab) {
    current.preview.remove(tab.view);
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.close({ waitForBeforeUnload: false });
    current.tabs = current.tabs.filter((item) => item !== tab);
    if (current.active === tab.id) current.active = current.tabs[0]?.id ?? '';
    this.showActive(current);
  }

  private close(id: string) {
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.delete(id);
    current.preview.close();
    for (const tab of [...current.tabs]) this.removeTab(current, tab);
    current.downloads.close();
  }
}
