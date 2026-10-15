import { app, utilityProcess, dialog, shell, safeStorage, nativeImage, type BrowserWindow, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

export class CoreHost {
  private child?: UtilityProcess;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  onChange?: () => void;
  async start(window?: BrowserWindow) {
    const child = utilityProcess.fork(join(app.getAppPath(), 'dist/src/core/entry.js'), [], {
      env: { ...process.env, AI_TEAM_DATA_DIR: app.getPath('userData'),
        MULTI_AI_WORKSPACE_RUNTIME: app.isPackaged ? join(process.resourcesPath, 'workspace-runtime')
          : join(app.getAppPath(), 'workspace-runtime', process.platform === 'darwin' ? 'mac-arm64' : 'win-x64') },
      stdio: 'pipe', serviceName: 'multi-AI work Core' });
    this.child = child;
    child.stdout?.resume(); child.stderr?.resume();
    await new Promise<void>((resolve, reject) => {
      child.on('message', input => {
        if (input.type === 'ready') resolve();
        if (input.type === 'changed') this.onChange?.();
        if (input.type === 'fatal') reject(new Error(input.error));
        if (input.type === 'host') void this.host(input.method, input.params, window).then(result => child.postMessage({ type: 'host-result', id: input.id, result }))
          .catch(error => child.postMessage({ type: 'host-result', id: input.id, error: error.message }));
        if (input.type === 'result') {
          const handler = this.pending.get(input.id); this.pending.delete(input.id);
          if (input.error) handler?.reject(new Error(input.error)); else handler?.resolve(input.result);
        }
      });
      child.on('exit', code => {
        if (this.child === child) this.child = undefined;
        reject(new Error(`Core 已停止 (${code})`));
        for (const handler of this.pending.values()) handler.reject(new Error('Core 已断开，请重新启动应用'));
        this.pending.clear();
        this.onChange?.();
      });
    });
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('Core 尚未启动')); return; }
      this.pending.set(id, { resolve, reject }); this.child.postMessage({ type: 'request', id, method, params });
    });
  }
  async close() {
    const child = this.child; if (!child) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 15000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); }); child.postMessage({ type: 'close' });
    });
    this.child = undefined;
  }
  private async host(method: string, params: Record<string, unknown>, window?: BrowserWindow) {
    if (method === 'encrypt' || method === 'decrypt') {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('系统凭据保护不可用，请配置安全后端');
      return method === 'encrypt' ? safeStorage.encryptString(String(params.value)).toString('base64')
        : safeStorage.decryptString(Buffer.from(String(params.value), 'base64'));
    }
    if (method === 'chooseDirectory' || method === 'chooseFile') {
      if (!window) throw new Error('目录选择需要桌面窗口');
      const result = await dialog.showOpenDialog(window, { properties: method === 'chooseDirectory' ? ['openDirectory'] : params.multiple ? ['openFile', 'multiSelections'] : ['openFile'] });
      return { path: result.canceled ? undefined : result.filePaths[0], paths: result.canceled ? [] : result.filePaths };
    }
    if (method === 'chooseAvatar') {
      if (!window) throw new Error('选择头像需要桌面窗口');
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (result.canceled) return { cancelled: true };
      const path = result.filePaths[0];
      if ((await stat(path)).size > 12 * 1024 * 1024) throw new Error('请选择小于 12 MB 的图片');
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) throw new Error('图片无法读取，请选择 PNG、JPEG 或 WebP');
      const size = image.getSize();
      const avatar = image.resize(size.width > size.height ? { width: 192 } : { height: 192 }).toDataURL();
      if (avatar.length > 260000) throw new Error('头像图片过大，请换一张图片');
      return { avatar };
    }
    if (method === 'openPath') { const error = await shell.openPath(String(params.path)); if (error) throw new Error(error); return { ok: true }; }
    throw new Error('不支持的平台操作');
  }
}
