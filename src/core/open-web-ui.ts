import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function openWebUi(url: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(new URL('/', url), {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      if (response.ok) break;
    } catch {
      signal.throwIfAborted();
    }
    if (Date.now() >= deadline) throw new Error('开发界面尚未启动，请启动界面后重新启动 Core。');
    await delay(250, undefined, { signal });
  }
  let command = 'xdg-open';
  if (process.platform === 'darwin') command = '/usr/bin/open';
  else if (process.platform === 'win32') command = 'rundll32.exe';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', signal });
    child.once('error', () => reject(new Error('开发界面无法打开，请检查默认浏览器设置。')));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('开发界面无法打开，请检查默认浏览器设置。')),
    );
  });
}
