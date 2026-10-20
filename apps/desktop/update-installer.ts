import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { createHelperLaunch } from './update-helpers/launcher.js';
import { prepareMacApplication } from './update-helpers/mac-prepare.js';
import { macUpdateHelper } from './update-helpers/mac-script.js';
import { windowsUpdateBootstrap, windowsUpdateHelper } from './update-helpers/windows-script.js';

const execute = promisify(execFile);

export interface UpdateInstallerInput {
  packagePath: string;
  version: string;
  cacheDirectory: string;
  parentPid: number;
  executablePath: string;
  platform: 'darwin' | 'win32';
  architecture: 'arm64' | 'x64';
  bundleId: string;
}

export async function prepareUpdateInstaller(input: UpdateInstallerInput): Promise<{
  launch(): Promise<void>;
  cleanup(): Promise<void>;
}> {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version)) throw new Error('更新版本无效');
  if (!Number.isSafeInteger(input.parentPid) || input.parentPid <= 0)
    throw new Error('当前应用进程无效，请重新启动后重试');
  const cacheDirectory = resolve(input.cacheDirectory);
  const packageRelative = relative(cacheDirectory, resolve(input.packagePath));
  if (!packageRelative || packageRelative.startsWith('..') || isAbsolute(packageRelative)) {
    throw new Error('更新包缓存位置无效，请重新下载');
  }
  const packageInfo = await lstat(input.packagePath).catch(() => undefined);
  if (!packageInfo?.isFile()) throw new Error('更新包不可用，请重新下载');
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 }).catch(() => {
    throw new Error('无法创建更新缓存，请检查存储空间和权限');
  });
  const jobDirectory = await mkdtemp(join(cacheDirectory, 'installer-')).catch(() => {
    throw new Error('无法创建更新安装目录，请重试');
  });
  let stagePath: string | undefined;
  try {
    const common = {
      version: input.version,
      parentPid: input.parentPid,
      packagePath: resolve(input.packagePath),
      jobDirectory,
      readyPath: join(jobDirectory, 'ready.json'),
      cancelPath: join(jobDirectory, 'cancel'),
      receiptPath: join(cacheDirectory, 'install-result.json'),
    };
    let executable: string;
    let args: string[];
    let config: Record<string, unknown>;
    if (input.platform === 'darwin') {
      const prepared = await prepareMacApplication(input, jobDirectory);
      stagePath = prepared.stagePath;
      config = { ...common, ...prepared };
      executable = '/usr/bin/osascript';
      args = [
        '-l',
        'JavaScript',
        join(jobDirectory, 'install.js'),
        join(jobDirectory, 'config.json'),
      ];
      await writeFile(join(jobDirectory, 'install.js'), macUpdateHelper, { mode: 0o600 });
    } else {
      const installDirectory = await validateWindowsInstallation(input);
      config = {
        ...common,
        installDirectory,
        executablePath: input.executablePath,
        uninstallerPath: win32.join(installDirectory, 'Uninstall multi-AI work.exe'),
      };
      executable = win32.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(jobDirectory, 'launch.ps1'),
        '-ConfigPath',
        join(jobDirectory, 'config.json'),
      ];
      await writeFile(join(jobDirectory, 'install.ps1'), '\ufeff' + windowsUpdateHelper, {
        mode: 0o600,
      });
      await writeFile(join(jobDirectory, 'launch.ps1'), '\ufeff' + windowsUpdateBootstrap, {
        mode: 0o600,
      });
    }
    await writeFile(join(jobDirectory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    await rm(common.receiptPath, { force: true });
    const helper = createHelperLaunch({ executable, args, ...common });
    return {
      launch: helper.launch,
      async cleanup() {
        await helper.cancel();
        if (stagePath) await rm(stagePath, { recursive: true, force: true });
        await rm(jobDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (stagePath) await rm(stagePath, { recursive: true, force: true });
    await rm(jobDirectory, { recursive: true, force: true });
    throw new Error(
      error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
        ? error.message
        : '无法准备更新安装，请重试',
    );
  }
}

async function validateWindowsInstallation(input: UpdateInstallerInput): Promise<string> {
  if (input.architecture !== 'x64') throw new Error('当前 Windows 架构不支持内置更新');
  const directory = win32.dirname(input.executablePath);
  if (
    win32.basename(input.executablePath) !== 'multi-AI work.exe' ||
    /win-unpacked/i.test(directory)
  ) {
    throw new Error('请先通过安装包安装应用，再使用内置更新');
  }
  const uninstaller = win32.join(directory, 'Uninstall multi-AI work.exe');
  await access(uninstaller, constants.R_OK).catch(() => {
    throw new Error('未找到已安装的应用，请使用安装包安装');
  });
  if (!(await lstat(uninstaller)).isFile()) throw new Error('未找到已安装的应用，请使用安装包安装');
  if ((await realpath(input.executablePath)) !== input.executablePath)
    throw new Error('应用安装位置无效，请使用安装包重新安装');
  const header = await execute(
    win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
    { windowsHide: true },
  );
  if (Number(header.stdout.trim()) < 5)
    throw new Error('内置更新需要 Windows PowerShell 5 或更新版本');
  return directory;
}
