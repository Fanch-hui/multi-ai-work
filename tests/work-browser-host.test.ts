import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSnapshot } from '../src/domain/work-browser.js';
import { browserUrl, WorkBrowserHost } from '../apps/desktop/work-browser-host.js';

const mocks = vi.hoisted(() => ({
  views: [] as any[],
  partitions: new Map<string, any>(),
}));

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      if (!mocks.partitions.has(partition)) {
        const target = new EventEmitter() as any;
        target.setPermissionRequestHandler = vi.fn();
        target.setPermissionCheckHandler = vi.fn();
        mocks.partitions.set(partition, target);
      }
      return mocks.partitions.get(partition);
    },
  },
  WebContentsView: class {
    webContents = new Contents();
    setVisible = vi.fn();
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(public options: any) {
      mocks.views.push(this);
    }
  },
}));

class Contents extends EventEmitter {
  id = Math.random();
  url = '';
  destroyed = false;
  attached = false;
  pageError?: string;
  failInput = false;
  windowHandler?: (input: { url: string }) => unknown;
  navigationHistory = { canGoBack: () => false, goBack: vi.fn() };
  debugger = {
    isAttached: () => this.attached,
    attach: vi.fn(() => {
      this.attached = true;
    }),
    detach: vi.fn(() => {
      this.attached = false;
    }),
    sendCommand: vi.fn(async (method: string, params: any) => {
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', url: this.url } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 12 };
      if (method === 'Page.captureScreenshot') return { data: 'png-base64' };
      if (method === 'Runtime.callFunctionOn') {
        if (params.functionDeclaration.includes('function collectPage'))
          return {
            result: {
              value: {
                text: 'Visible article',
                elements: [{ ref: 'f0:1', role: 'button', name: 'Save' }],
              },
            },
          };
        if (this.pageError)
          return { exceptionDetails: { exception: { description: this.pageError } } };
        return { result: { value: { x: 10, y: 20 } } };
      }
      if (method.startsWith('Input.') && this.failInput) throw new Error('Target closed');
      return {};
    }),
  };
  getTitle() {
    return 'Article';
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return false;
  }
  loadURL = vi.fn(async (url: string) => {
    this.emit('did-start-navigation');
    this.url = url;
  });
  setWindowOpenHandler(handler: Contents['windowHandler']) {
    this.windowHandler = handler;
  }
  close = vi.fn(() => {
    this.destroyed = true;
    this.emit('destroyed');
  });
}

let downloadDirectory: string;
let host: WorkBrowserHost;
let window: any;
const open = () =>
  host.request('browser.open', {
    sessionId: 'session',
    profileId: 'profile',
    url: 'https://example.com',
    downloadDirectory,
  });
const request = (method: Parameters<WorkBrowserHost['request']>[0], params = {}) =>
  host.request(method, { sessionId: 'session', ...params });
const snapshot = () => request('browser.snapshot') as Promise<BrowserSnapshot>;

beforeEach(async () => {
  mocks.views = [];
  mocks.partitions.clear();
  downloadDirectory = await mkdtemp(join(tmpdir(), 'work-browser-test-'));
  window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 100, y: 100, width: 1000, height: 800 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  host = new WorkBrowserHost(window);
});

afterEach(async () => {
  host.closeAll();
  await rm(downloadDirectory, { recursive: true, force: true });
});

describe('dedicated work browser host', () => {
  it('isolates browser sessions and blocks privileged schemes and page permissions', async () => {
    await open();
    const view = mocks.views[0];
    expect(view.options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: expect.stringMatching(/^persist:work-browser-[a-f0-9]{64}$/),
    });
    expect(view.options.webPreferences).not.toHaveProperty('preload');
    expect(view.setVisible).toHaveBeenCalledWith(false);
    const event = { preventDefault: vi.fn() };
    view.webContents.emit('will-navigate', event, 'file:///private/data');
    view.webContents.emit('will-frame-navigate', { ...event, url: 'javascript:alert(1)' });
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    const profile = [...mocks.partitions.values()][0];
    expect(profile.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    const permission = vi.fn();
    profile.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(() => browserUrl('https://user:password@example.com')).toThrow('HTTP');
    expect(() => browserUrl('file:///tmp/readme')).toThrow('HTTP');
  });

  it('reserves a profile before asynchronous setup and keeps one owner', async () => {
    const first = open();
    await expect(
      host.request('browser.open', {
        sessionId: 'other',
        profileId: 'profile',
        url: 'https://example.com',
        downloadDirectory,
      }),
    ).rejects.toThrow('其他任务');
    await first;
    expect(mocks.views).toHaveLength(1);
  });

  it('does not create a page when shutdown happens during session setup', async () => {
    const opening = open();
    host.closeAll();
    await expect(opening).rejects.toThrow('会话已关闭');
    expect(mocks.views).toHaveLength(0);
    expect([...mocks.partitions.values()][0].listenerCount('will-download')).toBe(0);
  });

  it('uses isolated world snapshots, rejects stale refs, and sends trusted CDP input', async () => {
    await open();
    const page = await snapshot();
    const contents = mocks.views[0].webContents as Contents;
    expect(page).toMatchObject({ text: 'Visible article', elements: [{ ref: 'f0:1' }] });
    await expect(
      request('browser.action', {
        action: { revision: 'old', action: 'click', ref: 'f0:1' },
      }),
    ).rejects.toThrow('快照');
    await request('browser.action', {
      action: { revision: page.revision, action: 'click', ref: 'f0:1' },
    });
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      x: 10,
      y: 20,
    });
    await expect(
      request('browser.action', {
        action: { revision: page.revision, action: 'click', ref: 'f0:1' },
      }),
    ).rejects.toThrow('快照');
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
      'Page.setInterceptFileChooserDialog',
      { enabled: true },
    );
  });

  it('pauses reading and input during handoff and invalidates the previous snapshot', async () => {
    await open();
    const old = await snapshot();
    await request('browser.interactive', { interactive: true });
    await expect(snapshot()).rejects.toThrow('用户操作');
    await request('browser.interactive', { interactive: false });
    await expect(
      request('browser.action', {
        action: { revision: old.revision, action: 'click', ref: 'f0:1' },
      }),
    ).rejects.toThrow('快照');
  });

  it('collects visible text without serializing input or password values', async () => {
    await open();
    await snapshot();
    const contents = mocks.views[0].webContents as Contents;
    const invocation = contents.debugger.sendCommand.mock.calls.find(
      ([method, params]) =>
        method === 'Runtime.callFunctionOn' &&
        params.functionDeclaration.includes('function collectPage'),
    )!;
    class Input {
      type = 'password';
      value = 'private-password';
      textContent = 'private-password';
      tagName = 'INPUT';
      getAttribute() {
        return 'private-password';
      }
      getBoundingClientRect() {
        return { width: 100, height: 30 };
      }
    }
    const value = runInNewContext(`(${invocation[1].functionDeclaration})('rev','f0:',200)`, {
      HTMLInputElement: Input,
      MutationObserver: class {
        observe() {}
      },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
      document: { body: { innerText: 'Public text' }, querySelectorAll: () => [new Input()] },
    });
    expect(JSON.stringify(value)).not.toContain('private-password');
    expect(value.elements[0].name).toBe('[密码输入框]');
  });

  it('marks an interrupted dispatched action for reconciliation', async () => {
    await open();
    const page = await snapshot();
    mocks.views[0].webContents.failInput = true;
    await expect(
      request('browser.action', {
        action: { revision: page.revision, action: 'click', ref: 'f0:1' },
      }),
    ).rejects.toThrow('BROWSER_ACTION_UNKNOWN');
  });

  it('checks the isolated document mutation state before dispatching input', async () => {
    await open();
    const page = await snapshot();
    const contents = mocks.views[0].webContents as Contents;
    contents.pageError = '页面发生变化，请重新读取页面';
    await expect(
      request('browser.action', {
        action: { revision: page.revision, action: 'click', ref: 'f0:1' },
      }),
    ).rejects.toThrow('页面发生变化');
    expect(
      contents.debugger.sendCommand.mock.calls.some(([method]) => method.startsWith('Input.')),
    ).toBe(false);
  });

  it('mounts only inside the App content area and keeps tabs and shutdown scoped', async () => {
    await open();
    await expect(
      request('browser.present', {
        visible: true,
        bounds: { x: 0, y: 0, width: 1200, height: 100 },
      }),
    ).rejects.toThrow('位置');
    await request('browser.present', {
      visible: true,
      bounds: { x: 100, y: 20, width: 800, height: 700 },
    });
    expect(window.contentView.addChildView).toHaveBeenCalledWith(mocks.views[0]);
    const shield = mocks.views[1];
    expect(window.contentView.addChildView).toHaveBeenLastCalledWith(shield);
    await request('browser.interactive', { interactive: true });
    expect(shield.setVisible).toHaveBeenLastCalledWith(false);
    await request('browser.interactive', { interactive: false });
    expect(shield.setVisible).toHaveBeenLastCalledWith(true);
    const contents = mocks.views[0].webContents as Contents;
    contents.windowHandler!({ url: 'file:///tmp/private' });
    expect(mocks.views).toHaveLength(2);
    const popup = contents.windowHandler!({ url: 'https://example.com/next' }) as any;
    expect(popup.action).toBe('allow');
    popup.createWindow({ webPreferences: {} });
    expect(mocks.views).toHaveLength(3);
    expect(await request('browser.tabs')).toHaveLength(2);
    host.closeAll();
    expect(mocks.views.every((view) => view.webContents.destroyed)).toBe(true);
    await expect(snapshot()).rejects.toThrow('会话已关闭');
  });

  it('retains Electron popup options and opener while keeping login tabs within the same session', async () => {
    await open();
    await request('browser.present', {
      visible: true,
      bounds: { x: 100, y: 20, width: 800, height: 700 },
    });
    await request('browser.interactive', { interactive: true });
    const opener = mocks.views[0];
    const handler = opener.webContents.windowHandler({ url: 'about:blank' });
    expect(handler.action).toBe('allow');
    const popupContents = handler.createWindow({
      webPreferences: {
        openerId: opener.webContents.id,
        partition: 'wrong-partition',
        session: 'wrong-session',
        preload: '/unsafe.js',
        nodeIntegration: true,
        sandbox: false,
      },
    });
    const popup = mocks.views.at(-1);
    expect(popupContents).toBe(popup.webContents);
    expect(popup.webContents.loadURL).not.toHaveBeenCalled();
    expect(popup.options.webPreferences).toMatchObject({
      openerId: opener.webContents.id,
      partition: opener.options.webPreferences.partition,
      session: opener.options.webPreferences.session,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
    });
    expect(popup.options.webPreferences).not.toHaveProperty('preload');
    expect(window.contentView.addChildView).toHaveBeenLastCalledWith(popup);
    const tabs = (await request('browser.tabs')) as any[];
    expect(tabs.find((tab) => tab.active).id).not.toBe(tabs[0].id);
    await request('browser.tabs', { operation: 'select', tabId: tabs[0].id });
    expect(window.contentView.addChildView).toHaveBeenLastCalledWith(opener);
    await expect(snapshot()).rejects.toThrow('用户操作');
    const event = { url: 'file:///private/document', preventDefault: vi.fn() };
    popupContents.emit('will-frame-navigate', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await request('browser.tabs', { operation: 'close', tabId: tabs[1].id });
    expect(popupContents.destroyed).toBe(true);
    expect(await request('browser.tabs')).toHaveLength(1);
  });

  it('owns downloads by WebContents, uses the Core directory and cancels pending items', async () => {
    await open();
    const partition = [...mocks.partitions.values()][0];
    const item = new EventEmitter() as any;
    item.getFilename = () => '../../report.pdf';
    item.setSavePath = vi.fn();
    item.getMimeType = () => 'application/pdf';
    item.getReceivedBytes = () => 50;
    item.cancel = vi.fn();
    const event = { preventDefault: vi.fn() };
    partition.emit('will-download', event, item, mocks.views[0].webContents);
    const path = item.setSavePath.mock.calls[0][0];
    expect(path).toMatch(new RegExp(`^${downloadDirectory}/[a-f0-9-]+-report.pdf$`));
    item.emit('done', {}, 'completed');
    expect(await request('browser.downloads')).toEqual([
      { path, name: 'report.pdf', mimeType: 'application/pdf', size: 50 },
    ]);
    expect(await request('browser.downloads')).toHaveLength(1);
    partition.emit('will-download', event, item, { id: 999 });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    partition.emit('will-download', event, item, mocks.views[0].webContents);
    host.closeAll();
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(partition.listenerCount('will-download')).toBe(0);
  });
});
