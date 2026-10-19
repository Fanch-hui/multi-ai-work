import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UpdateInstallerInput } from '../update-installer.js';

const execute = promisify(execFile);
const targetPath = '/Applications/multi-AI work.app';
const executableName = 'multi-AI work';

export async function prepareMacApplication(
  input: UpdateInstallerInput,
  jobDirectory: string,
): Promise<{
  targetPath: string;
  stagePath: string;
}> {
  if (input.architecture !== 'arm64') throw new Error('当前 macOS 架构不支持内置更新');
  if (input.executablePath !== join(targetPath, 'Contents', 'MacOS', executableName)) {
    throw new Error('请先将应用移至“应用程序”文件夹，再使用内置更新');
  }
  if ((await lstat(targetPath)).isSymbolicLink() || (await realpath(targetPath)) !== targetPath) {
    throw new Error('应用安装位置无效，请移至“应用程序”文件夹');
  }
  await access('/Applications', constants.W_OK).catch(() => {
    throw new Error('无法写入“应用程序”文件夹，请检查权限');
  });
  const extraction = join(jobDirectory, 'extracted');
  await execute('/usr/bin/ditto', ['-x', '-k', input.packagePath, extraction]).catch(() => {
    throw new Error('更新包无法解压，请重新下载');
  });
  const apps = (await readdir(extraction)).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1 || apps[0] !== 'multi-AI work.app')
    throw new Error('更新包未包含有效的应用');
  const application = join(extraction, apps[0]);
  await validateApplication(application, input);
  const stagePath = '/Applications/.multi-AI-work-update-' + randomUUID() + '.app';
  try {
    await execute('/usr/bin/ditto', [application, stagePath]);
    await validateApplication(stagePath, input);
    return { stagePath, targetPath };
  } catch (error) {
    await rm(stagePath, { recursive: true, force: true });
    throw error;
  }
}

async function validateApplication(path: string, input: UpdateInstallerInput): Promise<void> {
  const plist = join(path, 'Contents', 'Info.plist');
  for (const [key, expected] of [
    ['CFBundleIdentifier', input.bundleId],
    ['CFBundleShortVersionString', input.version],
    ['CFBundleExecutable', executableName],
  ]) {
    const { stdout } = await execute('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :' + key,
      plist,
    ]).catch(() => {
      throw new Error('更新包的应用身份信息无效');
    });
    if (stdout.trim() !== expected)
      throw new Error(
        key === 'CFBundleShortVersionString' ? '更新包的应用版本不匹配' : '更新包的应用身份不匹配',
      );
  }
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]).catch(() => {
    throw new Error('更新包的应用签名无效，请重新下载');
  });
  await execute('/usr/bin/lipo', [
    '-verify_arch',
    input.architecture,
    join(path, 'Contents', 'MacOS', executableName),
  ]).catch(() => {
    throw new Error('更新包与当前 macOS 架构不匹配');
  });
}
