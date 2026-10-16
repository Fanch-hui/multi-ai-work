import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createHelperLaunch } from '../apps/desktop/update-helpers/launcher.js';
import { macUpdateHelper } from '../apps/desktop/update-helpers/mac-script.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'multi-ai-update-test-'));
  directories.push(directory);
  return directory;
}

describe('update installer helpers', () => {
  it('launch resolves only after the independent helper acknowledges readiness', async () => {
    const directory = await fixture();
    const readyPath = join(directory, 'ready.json');
    const cancelPath = join(directory, 'cancel');
    const receiptPath = join(directory, 'receipt.json');
    const scriptPath = join(directory, 'helper.cjs');
    await writeFile(scriptPath, `const fs = require('node:fs'); setTimeout(() => fs.writeFileSync(process.argv[2], '{}'), 150); setInterval(() => {}, 1000);`);
    const helper = createHelperLaunch({ executable: process.execPath, args: [scriptPath, readyPath], readyPath, cancelPath, receiptPath });
    try {
      await helper.launch();
      expect(await readFile(readyPath, 'utf8')).toBe('{}');
    } finally { await helper.cancel(); }
  });

  it('rejects a helper which exits before the ready handshake', async () => {
    const directory = await fixture();
    const helper = createHelperLaunch({ executable: process.execPath, args: ['-e', 'process.exit(1)'],
      readyPath: join(directory, 'ready'), cancelPath: join(directory, 'cancel'), receiptPath: join(directory, 'receipt') });
    await expect(helper.launch()).rejects.toThrow('更新安装进程未能就绪');
    await helper.cancel();
  });

  it.skipIf(process.platform === 'win32')('cancellation waits for the independent helper to exit before returning', async () => {
    const directory = await fixture();
    const readyPath = join(directory, 'ready.json');
    const stoppedPath = join(directory, 'stopped');
    const scriptPath = join(directory, 'helper.cjs');
    await writeFile(scriptPath, `
      const fs = require('node:fs');
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(process.argv[3], 'stopped');
        process.exit(0);
      }, 200));
      fs.writeFileSync(process.argv[2], '{}');
      setInterval(() => {}, 1000);
    `);
    const helper = createHelperLaunch({ executable: process.execPath, args: [scriptPath, readyPath, stoppedPath],
      readyPath, cancelPath: join(directory, 'cancel'), receiptPath: join(directory, 'receipt') });
    await helper.launch();
    await helper.cancel();
    expect(await readFile(stoppedPath, 'utf8')).toBe('stopped');
  });

  it.skipIf(process.platform !== 'darwin')('atomically exchanges macOS application directory fixtures using the helper C binding', async () => {
    const directory = await fixture();
    const left = join(directory, 'current.app');
    const right = join(directory, 'staged.app');
    await Promise.all([mkdir(left), mkdir(right)]);
    await writeFile(join(left, 'version'), 'old');
    await writeFile(join(right, 'version'), 'new');
    const scriptPath = join(directory, 'swap.js');
    const bindings = macUpdateHelper.slice(0, macUpdateHelper.indexOf('function run('));
    await writeFile(scriptPath, bindings + `function run(argv) { return $.renameatx_np(-2, argv[0], -2, argv[1], 2); }`);
    const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', scriptPath, left, right]);
    expect(stdout.trim()).toBe('0');
    expect(await readFile(join(left, 'version'), 'utf8')).toBe('new');
    expect(await readFile(join(right, 'version'), 'utf8')).toBe('old');
  });

  it.skipIf(process.platform !== 'darwin')('runs the macOS helper ready and cancellation path without replacing an application', async () => {
    const directory = await fixture();
    const jobDirectory = join(directory, 'job');
    const stagePath = join(directory, 'stage');
    const targetPath = join(directory, 'target');
    await Promise.all([jobDirectory, stagePath, targetPath].map(path => mkdir(path)));
    const packagePath = join(directory, 'package.zip');
    await writeFile(packagePath, 'fixture');
    const config = { jobDirectory, stagePath, targetPath, packagePath, parentPid: process.pid, version: '1.0.0',
      readyPath: join(jobDirectory, 'ready'), cancelPath: join(jobDirectory, 'cancel'), receiptPath: join(directory, 'receipt') };
    const scriptPath = join(jobDirectory, 'install.js');
    const configPath = join(jobDirectory, 'config.json');
    await writeFile(scriptPath, macUpdateHelper);
    await writeFile(configPath, JSON.stringify(config));
    const processHandle = spawn('/usr/bin/osascript', ['-l', 'JavaScript', scriptPath, configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    processHandle.stderr.on('data', value => { stderr += value; });
    const exited = new Promise<number | null>(resolve => processHandle.on('exit', resolve));
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !await readFile(config.readyPath, 'utf8').catch(() => '')) {
        if (processHandle.exitCode !== null) throw new Error(stderr);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(JSON.parse(await readFile(config.readyPath, 'utf8'))).toEqual({ ready: true });
      await writeFile(config.cancelPath, '');
      expect(await exited).toBe(0);
      await expect(readFile(packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(jobDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { if (processHandle.exitCode === null) processHandle.kill(); }
  });
});
