import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import type { ComputerHostMethod } from '../../src/domain/computer.js';

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export class ComputerHost {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private helperPath: string;
  constructor(options: { helperPath?: string } = {}) {
    this.helperPath =
      options.helperPath ?? join(process.resourcesPath ?? process.cwd(), 'computer-helper');
  }
  async request(
    method: ComputerHostMethod,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (method === 'computer.permissions') {
      if (process.platform !== 'darwin') throw new Error('电脑操作目前支持 macOS');
      const pane =
        params.permission === 'screenCapture' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
      return { opened: true };
    }
    if (
      method === 'computer.capabilities' &&
      (process.platform !== 'darwin' || !existsSync(this.helperPath))
    )
      return {
        available: false,
        accessibility: false,
        screenCapture: false,
        guidance:
          process.platform !== 'darwin'
            ? '电脑操作目前支持 macOS，其他平台可使用工作浏览器。'
            : '电脑操作组件尚未安装，请更新桌面 App。',
      };
    if (method === 'computer.release') {
      this.close();
      return { ok: true };
    }
    const child = this.ensureChild();
    if (this.pending.size) throw new Error('电脑正在处理上一项操作');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close('COMPUTER_ACTION_UNKNOWN: 系统操作超时，请观察窗口核对结果');
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...params, id, method })}\n`, (error) => {
        if (error) this.close('电脑操作组件连接中断');
      });
    });
  }
  close(message = 'COMPUTER_ACTION_UNKNOWN: 电脑操作已停止，请重新观察窗口核对结果') {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
  private ensureChild() {
    if (this.child) return this.child;
    if (process.platform !== 'darwin' || !existsSync(this.helperPath))
      throw new Error('电脑操作组件尚未就绪');
    const child = spawn(this.helperPath, [], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line.length > 24 * 1024 * 1024) return this.close('窗口截图过大，请关闭截图后重试');
      try {
        const response = JSON.parse(line) as { id?: string; result?: unknown; error?: string };
        const pending = response.id && this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id!);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(response.error));
        else pending.resolve(response.result);
      } catch {
        this.close('电脑操作组件返回格式错误');
      }
    });
    child.once('error', () => {
      if (this.child === child) this.close('无法启动电脑操作组件');
    });
    child.once('exit', () => {
      lines.close();
      if (this.child === child)
        this.close('COMPUTER_ACTION_UNKNOWN: 电脑组件已退出，请观察窗口核对结果');
    });
    return child;
  }
}
