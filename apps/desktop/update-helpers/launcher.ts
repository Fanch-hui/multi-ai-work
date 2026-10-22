import { spawn, type ChildProcess } from 'node:child_process';
import { access, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createHelperLaunch(input: {
  executable: string;
  args: string[];
  readyPath: string;
  receiptPath: string;
  cancelPath: string;
}): { launch(): Promise<void>; cancel(): Promise<void> } {
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let hasExited = false;
  return {
    async launch() {
      if (child) throw new Error('更新安装已经开始');
      child = spawn(input.executable, input.args, {
        cwd: dirname(dirname(input.readyPath)),
        // PowerShell exits before reading its script with DETACHED_PROCESS on Windows.
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
      });
      let failure: Error | undefined;
      exited = new Promise((resolve) => {
        child!.once('exit', () => {
          hasExited = true;
          resolve();
        });
        child!.once('error', (error) => {
          failure = error;
          if (!child!.pid) {
            hasExited = true;
            resolve();
          }
        });
      });
      if (child.pid) {
        const pidPath = join(dirname(input.readyPath), 'process.json');
        await writeFile(pidPath + '.tmp', JSON.stringify({ pid: child.pid }), { mode: 0o600 });
        await rename(pidPath + '.tmp', pidPath);
      }
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw new Error('无法启动更新安装进程');
        if (hasExited) throw new Error('更新安装进程未能就绪');
        if (
          await access(input.readyPath).then(
            () => true,
            () => false,
          )
        ) {
          child.unref();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('更新安装进程准备超时，请重试');
    },
    async cancel() {
      if (!child?.pid || hasExited) return;
      await writeFile(input.cancelPath, '', { mode: 0o600 }).catch((error) => {
        if (!hasExited) throw new Error('无法取消更新安装进程', { cause: error });
      });
      if (hasExited) return;
      // The Windows bootstrap must wait until the independent helper honors cancellation.
      if (process.platform !== 'win32') child.kill();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('更新安装进程尚未退出，请稍后重试')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
