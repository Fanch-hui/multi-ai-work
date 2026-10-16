import { app, utilityProcess } from 'electron';
import { join } from 'node:path';

export function copyDataDirectory(source: string, target: string): Promise<string> {
  const child = utilityProcess.fork(join(app.getAppPath(), 'dist/apps/desktop/data-directory-worker.js'), [source, target], {
    stdio: 'pipe', serviceName: 'multi-AI work 数据迁移',
  });
  child.stdout?.resume(); child.stderr?.resume();
  return new Promise((resolve, reject) => {
    let path: string | undefined, error: string | undefined;
    child.on('message', input => {
      if (input.type === 'complete' && typeof input.path === 'string') path = input.path;
      if (input.type === 'error' && typeof input.error === 'string') error = input.error;
    });
    child.once('exit', code => {
      if (code === 0 && path === target) resolve(path);
      else reject(new Error(error ?? '数据复制未完成，原位置的数据仍保留'));
    });
  });
}
