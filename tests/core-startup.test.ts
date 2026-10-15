import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it('Core 构造失败时向桌面宿主回传实际错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-ai-core-startup-'));
  const dataDirectory = join(root, 'data-file');
  await writeFile(dataDirectory, 'occupied');
  const child = fork(fileURLToPath(new URL('../src/core/entry.ts', import.meta.url)), [], {
    execArgv: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href],
    env: { ...process.env, AI_TEAM_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', timer: ReturnType<typeof setTimeout> | undefined;
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  try {
    const fatal = await new Promise<{ type: string; error: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Core 启动错误未回传')), 60000);
      child.on('message', message => {
        const input = message as { type: string; error: string };
        if (input.type === 'fatal') resolve(input);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Core 提前退出 (${code}): ${stderr}`)));
    });
    expect(fatal.error).toContain('EEXIST');
    expect(fatal.error).toContain(dataDirectory);
    child.disconnect();
    expect(await exited).toBe(1);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 75000);
