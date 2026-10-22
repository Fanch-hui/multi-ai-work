import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createHelperLaunch } from '../apps/desktop/update-helpers/launcher.js';
import { macUpdateHelper } from '../apps/desktop/update-helpers/mac-script.js';
import { windowsUpdateBootstrap } from '../apps/desktop/update-helpers/windows-script.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'multi-ai-update-test-'));
  directories.push(directory);
  return directory;
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

async function windowsFixture() {
  const directory = await fixture();
  const job = join(directory, 'Windows 更新', 'job');
  await mkdir(job, { recursive: true });
  const readyPath = join(job, 'ready.json');
  const cancelPath = join(job, 'cancel');
  const stoppedPath = join(directory, 'stopped');
  const configPath = join(job, 'config.json');
  const bootstrapPath = join(job, 'launch.ps1');
  await writeFile(configPath, JSON.stringify({ readyPath, cancelPath, stoppedPath }));
  await writeFile(
    bootstrapPath,
    '\ufeff' +
      windowsUpdateBootstrap.replace(
        '\n',
        "\n[IO.File]::WriteAllText(($ConfigPath + '.pid'), [string]$PID)\n",
      ),
  );
  await writeFile(
    join(job, 'install.ps1'),
    `\ufeffparam([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
[IO.File]::WriteAllText(($ConfigPath + '.helper.pid'), [string]$PID)
[IO.File]::WriteAllText($config.readyPath, '{"ready":true}')
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (!(Test-Path -LiteralPath $config.cancelPath) -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 100
}
[IO.File]::WriteAllText($config.stoppedPath, 'stopped')
# Keep acknowledgement and actual process exit observably separate.
Start-Sleep -Milliseconds 200
`,
  );
  return {
    directory,
    stoppedPath,
    bootstrapPidPath: configPath + '.pid',
    helperPidPath: configPath + '.helper.pid',
    input: {
      executable: win32.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        bootstrapPath,
        '-ConfigPath',
        configPath,
      ],
      readyPath,
      cancelPath,
      receiptPath: join(directory, 'receipt.json'),
    },
  };
}

describe('update installer helpers', () => {
  it('launch resolves only after the independent helper acknowledges readiness', async () => {
    const directory = await fixture();
    const readyPath = join(directory, 'ready.json');
    const cancelPath = join(directory, 'cancel');
    const receiptPath = join(directory, 'receipt.json');
    const scriptPath = join(directory, 'helper.cjs');
    await writeFile(
      scriptPath,
      `const fs = require('node:fs'); setTimeout(() => fs.writeFileSync(process.argv[2], '{}'), 150);
setInterval(() => { if (fs.existsSync(process.argv[3])) process.exit(0); }, 50);`,
    );
    const helper = createHelperLaunch({
      executable: process.execPath,
      args: [scriptPath, readyPath, cancelPath],
      readyPath,
      cancelPath,
      receiptPath,
    });
    try {
      await helper.launch();
      expect(await readFile(readyPath, 'utf8')).toBe('{}');
      const record = JSON.parse(await readFile(join(directory, 'process.json'), 'utf8'));
      expect(record.pid).toBeGreaterThan(0);
      expect(processIsRunning(record.pid)).toBe(true);
      expect(await readdir(directory)).not.toContain('process.json.tmp');
    } finally {
      await helper.cancel();
    }
  });

  it('rejects a helper which exits before the ready handshake', async () => {
    const directory = await fixture();
    const helper = createHelperLaunch({
      executable: process.execPath,
      args: ['-e', 'process.exit(1)'],
      readyPath: join(directory, 'ready'),
      cancelPath: join(directory, 'cancel'),
      receiptPath: join(directory, 'receipt'),
    });
    await expect(helper.launch()).rejects.toThrow('更新安装进程未能就绪');
    await helper.cancel();
  });

  it.skipIf(process.platform !== 'win32')(
    'keeps the Windows PowerShell helper running after its launcher exits',
    async () => {
      const { directory, input, stoppedPath, bootstrapPidPath, helperPidPath } =
        await windowsFixture();
      const parentPath = join(directory, 'parent.mjs');
      await writeFile(
        parentPath,
        `const [moduleUrl, config] = process.argv.slice(2);
const { createHelperLaunch } = await import(moduleUrl);
await createHelperLaunch(JSON.parse(config)).launch();
`,
      );
      try {
        await promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            parentPath,
            pathToFileURL(resolve('apps/desktop/update-helpers/launcher.ts')).href,
            JSON.stringify(input),
          ],
          { windowsHide: true, timeout: 20_000 },
        );
        expect(JSON.parse(await readFile(input.readyPath, 'utf8'))).toEqual({ ready: true });
        expect(processIsRunning(Number(await readFile(helperPidPath, 'utf8')))).toBe(true);
        await expect(readFile(stoppedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await writeFile(input.cancelPath, '');
        try {
          await expect
            .poll(() => readFile(stoppedPath, 'utf8'), { timeout: 10_000 })
            .toBe('stopped');
        } finally {
          const pids = await Promise.all(
            [bootstrapPidPath, helperPidPath].map(async (path) =>
              Number(await readFile(path, 'utf8')),
            ),
          );
          // The independent helper can outlive its bootstrap and writes stopped before exiting.
          await expect.poll(() => pids.some(processIsRunning), { timeout: 10_000 }).toBe(false);
        }
      }
    },
    35_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'waits for the independent Windows helper to acknowledge cancellation',
    async () => {
      const { input, stoppedPath } = await windowsFixture();
      const helper = createHelperLaunch(input);
      try {
        await helper.launch();
      } finally {
        await helper.cancel();
      }
      expect(await readFile(stoppedPath, 'utf8')).toBe('stopped');
    },
    25_000,
  );

  it.skipIf(process.platform === 'win32')(
    'cancellation waits for the independent helper to exit before returning',
    async () => {
      const directory = await fixture();
      const readyPath = join(directory, 'ready.json');
      const stoppedPath = join(directory, 'stopped');
      const scriptPath = join(directory, 'helper.cjs');
      await writeFile(
        scriptPath,
        `
      const fs = require('node:fs');
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(process.argv[3], 'stopped');
        process.exit(0);
      }, 200));
      fs.writeFileSync(process.argv[2], '{}');
      setInterval(() => {}, 1000);
    `,
      );
      const helper = createHelperLaunch({
        executable: process.execPath,
        args: [scriptPath, readyPath, stoppedPath],
        readyPath,
        cancelPath: join(directory, 'cancel'),
        receiptPath: join(directory, 'receipt'),
      });
      await helper.launch();
      await helper.cancel();
      expect(await readFile(stoppedPath, 'utf8')).toBe('stopped');
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'atomically exchanges macOS application directory fixtures using the helper C binding',
    async () => {
      const directory = await fixture();
      const left = join(directory, 'current.app');
      const right = join(directory, 'staged.app');
      await Promise.all([mkdir(left), mkdir(right)]);
      await writeFile(join(left, 'version'), 'old');
      await writeFile(join(right, 'version'), 'new');
      const scriptPath = join(directory, 'swap.js');
      const bindings = macUpdateHelper.slice(0, macUpdateHelper.indexOf('function run('));
      await writeFile(
        scriptPath,
        bindings + `function run(argv) { return $.renameatx_np(-2, argv[0], -2, argv[1], 2); }`,
      );
      const { stdout } = await promisify(execFile)('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        scriptPath,
        left,
        right,
      ]);
      expect(stdout.trim()).toBe('0');
      expect(await readFile(join(left, 'version'), 'utf8')).toBe('new');
      expect(await readFile(join(right, 'version'), 'utf8')).toBe('old');
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'runs the macOS helper ready and cancellation path without replacing an application',
    async () => {
      const directory = await fixture();
      const jobDirectory = join(directory, 'job');
      const stagePath = join(directory, 'stage');
      const targetPath = join(directory, 'target');
      await Promise.all([jobDirectory, stagePath, targetPath].map((path) => mkdir(path)));
      const packagePath = join(directory, 'package.zip');
      await writeFile(packagePath, 'fixture');
      const config = {
        jobDirectory,
        stagePath,
        targetPath,
        packagePath,
        parentPid: process.pid,
        version: '1.0.0',
        readyPath: join(jobDirectory, 'ready'),
        cancelPath: join(jobDirectory, 'cancel'),
        receiptPath: join(directory, 'receipt'),
      };
      const scriptPath = join(jobDirectory, 'install.js');
      const configPath = join(jobDirectory, 'config.json');
      await writeFile(scriptPath, macUpdateHelper);
      await writeFile(configPath, JSON.stringify(config));
      const processHandle = spawn(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', scriptPath, configPath],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      processHandle.stderr.on('data', (value) => {
        stderr += value;
      });
      const exited = new Promise<number | null>((resolve) => processHandle.on('exit', resolve));
      try {
        const deadline = Date.now() + 5000;
        while (
          Date.now() < deadline &&
          !(await readFile(config.readyPath, 'utf8').catch(() => ''))
        ) {
          if (processHandle.exitCode !== null) throw new Error(stderr);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(JSON.parse(await readFile(config.readyPath, 'utf8'))).toEqual({ ready: true });
        await writeFile(config.cancelPath, '');
        expect(await exited).toBe(0);
        await expect(readFile(packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(jobDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (processHandle.exitCode === null) processHandle.kill();
      }
    },
  );
});
