import { WebContentsView, type BrowserWindow } from 'electron';
import type { BrowserHostInput } from '../../src/domain/work-browser.js';

interface PreviewTab {
  id: string;
  view: WebContentsView;
}

export class WorkBrowserPreview {
  visible = false;
  private bounds?: BrowserHostInput['bounds'];
  private shield?: WebContentsView;
  private shieldReady?: Promise<void>;
  private closed = false;

  constructor(private window?: BrowserWindow) {}

  async present(input: BrowserHostInput, tabs: PreviewTab[], active: string, interactive: boolean) {
    if (this.closed) throw new Error('浏览器预览已关闭');
    if (!this.window || this.window.isDestroyed()) throw new Error('浏览器预览需要桌面窗口');
    if (input.bounds) {
      const bounds = input.bounds;
      const size = this.window.getContentBounds();
      if (
        !Object.values(bounds).every(Number.isFinite) ||
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.width < 1 ||
        bounds.height < 1 ||
        bounds.x + bounds.width > size.width ||
        bounds.y + bounds.height > size.height
      )
        throw new Error('浏览器预览位置无效');
      this.bounds = bounds;
    }
    if (input.visible && !this.bounds) throw new Error('请先设置浏览器预览位置');
    if (input.visible) {
      this.shieldReady ??= this.createShield();
      await this.shieldReady;
    }
    if (this.closed) throw new Error('浏览器预览已关闭');
    this.visible = input.visible === true;
    this.render(tabs, active, interactive);
    return { ok: true };
  }

  render(tabs: PreviewTab[], active: string, interactive: boolean) {
    if (this.closed || !this.window || this.window.isDestroyed()) return;
    if (this.shield) this.window.contentView.removeChildView(this.shield);
    for (const tab of tabs) {
      const visible = this.visible && tab.id === active;
      this.window.contentView.removeChildView(tab.view);
      if (this.bounds) tab.view.setBounds(this.bounds);
      if (visible) this.window.contentView.addChildView(tab.view);
      tab.view.setVisible(visible);
      if (!interactive && tab.view.webContents.isFocused()) this.window.webContents.focus();
    }
    if (this.visible && !interactive && this.shield && this.bounds) {
      this.shield.setBounds(this.bounds);
      this.window.contentView.addChildView(this.shield);
      this.shield.setVisible(true);
    } else this.shield?.setVisible(false);
  }

  remove(view: WebContentsView) {
    if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
  }

  close() {
    this.closed = true;
    this.visible = false;
    if (!this.shield) return;
    this.remove(this.shield);
    if (!this.shield.webContents.isDestroyed())
      this.shield.webContents.close({ waitForBeforeUnload: false });
    this.shield = undefined;
  }

  private async createShield() {
    const shield = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'work-browser-input-cover',
      },
    });
    shield.setBackgroundColor('#00000000');
    shield.webContents.on('before-input-event', (event) => event.preventDefault());
    shield.webContents.on('will-navigate', (event) => event.preventDefault());
    shield.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.shield = shield;
    await shield.webContents.loadURL(
      'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; style-src %27unsafe-inline%27"><style>html,body{margin:0;width:100%;height:100%;background:transparent}</style>',
    );
  }
}
