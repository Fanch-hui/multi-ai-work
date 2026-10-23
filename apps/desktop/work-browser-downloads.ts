import { basename, isAbsolute, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DownloadItem, Session, WebContents } from 'electron';
import type { BrowserDownload } from '../../src/domain/work-browser.js';

export class WorkBrowserDownloads {
  private owners = new Set<number>();
  private pending = new Set<DownloadItem>();
  private completed: BrowserDownload[] = [];
  private directory?: string;
  private closed = false;
  private receive: (event: Electron.Event, item: DownloadItem, contents: WebContents) => void;

  constructor(private session: Session) {
    this.receive = (event, item, contents) => {
      if (!contents || !this.owners.has(contents.id)) {
        event.preventDefault();
        return;
      }
      if (this.closed || !this.directory) {
        event.preventDefault();
        return;
      }
      const name =
        basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
      const path = join(this.directory, `${randomUUID()}-${name}`);
      item.setSavePath(path);
      this.pending.add(item);
      item.once('done', (_event, state) => {
        this.pending.delete(item);
        if (this.closed || state !== 'completed') return;
        this.completed.push({
          path,
          name,
          mimeType: item.getMimeType(),
          size: item.getReceivedBytes(),
        });
      });
    };
    session.on('will-download', this.receive);
  }

  async configure(directory: string) {
    if (!isAbsolute(directory)) throw new Error('下载目录必须是绝对路径');
    await mkdir(directory, { recursive: true });
    this.directory = directory;
  }

  add(contents: WebContents) {
    this.owners.add(contents.id);
    contents.once('destroyed', () => {
      this.owners.delete(contents.id);
      this.detachWhenClosed();
    });
  }

  list() {
    return this.completed.map((item) => ({ ...item }));
  }

  close() {
    this.closed = true;
    for (const item of this.pending) item.cancel();
    this.pending.clear();
    this.completed = [];
    this.detachWhenClosed();
  }

  private detachWhenClosed() {
    if (this.closed && this.owners.size === 0)
      this.session.removeListener('will-download', this.receive);
  }
}
