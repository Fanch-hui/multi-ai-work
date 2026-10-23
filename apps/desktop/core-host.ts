import { app, utilityProcess, net, type BrowserWindow, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CoreHostRequest,
  CoreResult,
  CoreToDesktopMessage,
  DesktopToCoreMessage,
} from '../../src/domain/core-ipc.js';
import type { ProviderSocket } from '../../src/providers/network.js';
import { createProviderSocketHost } from './provider-sockets.js';
import { handleCorePlatformRequest } from './core-platform.js';
import { WorkBrowserHost } from './work-browser-host.js';
import type { BrowserHostInput, BrowserHostMethod } from '../../src/domain/work-browser.js';

type RequestHandler = { resolve(value: unknown): void; reject(error: Error): void };
type StartupHandler = { resolve(): void; reject(error: Error): void };

export class CoreHost {
  private child?: UtilityProcess;
  private closing?: Promise<void>;
  private pending = new Map<string, RequestHandler>();
  private browser?: WorkBrowserHost;
  onChange?: () => void;

  get running() {
    return !!this.child;
  }

  async start(window?: BrowserWindow, dataDirectory = app.getPath('userData')) {
    if (this.child) throw new Error('Core 已经启动');
    const child = this.createChild(dataDirectory);
    this.child = child;
    this.browser = new WorkBrowserHost(window);
    const sockets = createProviderSocketHost(
      (url, headers) =>
        new net.WebSocket(url, { headers, useSessionCookies: false }) as unknown as ProviderSocket,
      (value) => child.postMessage(value),
    );
    this.drainChildOutput(child);
    await new Promise<void>((resolve, reject) => {
      const startup = { resolve, reject };
      child.on('message', (input) => {
        if (sockets.receive(input)) return;
        this.receive(child, input as CoreToDesktopMessage, startup, window);
      });
      child.on('exit', (code) => {
        sockets.close();
        this.childExited(child, code, startup);
      });
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('Core 尚未启动'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.send(this.child, { type: 'request', id, method, params });
    });
  }

  async close() {
    this.browser?.closeAll();
    const child = this.child;
    if (!child) return;
    this.closing ??= this.waitForChildClose(child).finally(() => {
      this.closing = undefined;
    });
    await this.closing;
  }

  private createChild(dataDirectory: string) {
    const runtimeDirectory = app.isPackaged
      ? join(process.resourcesPath, 'workspace-runtime')
      : join(
          app.getAppPath(),
          'workspace-runtime',
          process.platform === 'darwin' ? 'mac-arm64' : 'win-x64',
        );
    return utilityProcess.fork(join(app.getAppPath(), 'dist/src/core/entry.js'), [], {
      env: {
        ...process.env,
        AI_TEAM_DATA_DIR: dataDirectory,
        MULTI_AI_WORKSPACE_RUNTIME: runtimeDirectory,
      },
      stdio: 'pipe',
      serviceName: 'multi-AI work Core',
    });
  }

  private drainChildOutput(child: UtilityProcess) {
    child.stdout?.resume();
    if (process.argv.includes('--smoke-core')) child.stderr?.pipe(process.stderr);
    else child.stderr?.resume();
  }

  private send(child: UtilityProcess, message: DesktopToCoreMessage) {
    child.postMessage(message);
  }

  private receive(
    child: UtilityProcess,
    input: CoreToDesktopMessage,
    startup: StartupHandler,
    window?: BrowserWindow,
  ) {
    switch (input.type) {
      case 'ready':
        startup.resolve();
        return;
      case 'changed':
        this.onChange?.();
        return;
      case 'fatal':
        startup.reject(new Error(input.error));
        return;
      case 'host':
        void this.respondToHostRequest(child, input, window);
        return;
      case 'result':
        this.settleRequest(input);
        return;
      case 'closed':
        return;
    }
  }

  private settleRequest(input: CoreResult) {
    const handler = this.pending.get(input.id);
    this.pending.delete(input.id);
    if (input.error) handler?.reject(new Error(input.error));
    else handler?.resolve(input.result);
  }

  private async respondToHostRequest(
    child: UtilityProcess,
    input: CoreHostRequest,
    window?: BrowserWindow,
  ) {
    try {
      const result = input.method.startsWith('browser.')
        ? await this.browser?.request(
            input.method as BrowserHostMethod,
            input.params as unknown as BrowserHostInput,
          )
        : await handleCorePlatformRequest(input.method, input.params, window);
      this.send(child, { type: 'host-result', id: input.id, result });
    } catch (error) {
      this.send(child, { type: 'host-result', id: input.id, error: (error as Error).message });
    }
  }

  private childExited(child: UtilityProcess, code: number, startup: StartupHandler) {
    this.browser?.closeAll();
    if (this.child === child) this.child = undefined;
    startup.reject(new Error(`Core 已停止 (${code})`));
    for (const handler of this.pending.values()) {
      handler.reject(new Error('Core 已断开，请重新启动应用'));
    }
    this.pending.clear();
    this.onChange?.();
  }

  private waitForChildClose(child: UtilityProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let closed = false;
      const message = (input: CoreToDesktopMessage) => {
        if (input.type === 'closed') closed = true;
      };
      child.on('message', message);
      const forced = setTimeout(() => child.kill(), 15000);
      const timeout = setTimeout(() => reject(new Error('应用数据仍在使用，请退出后重试')), 20000);
      child.once('exit', (code) => {
        clearTimeout(forced);
        clearTimeout(timeout);
        child.removeListener('message', message);
        if (closed && code === 0) resolve();
        else reject(new Error('数据服务未正常关闭，请重试'));
      });
      this.send(child, { type: 'close' });
    });
  }
}
