import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AppUpdateAsset } from '../../src/domain/app-update.js';
import { verifyUpdateFile } from '../../src/updates/download.js';
import { compareUpdateVersions } from '../../src/updates/manifest.js';

const metadataName = 'candidate.json';
const directoryPattern = /^download-[a-zA-Z0-9]{6}$/;
const metadataSchema = z.object({
  format: z.literal(1),
  version: z.string(),
  platform: z.enum(['macos', 'windows']),
  architecture: z.enum(['arm64', 'x64']),
  kind: z.enum(['app-zip', 'nsis']),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string(),
});

type Metadata = z.infer<typeof metadataSchema>;
export type CachedUpdate = Metadata & { packagePath: string; directory: string };
type Selection = { version: string; asset: AppUpdateAsset };

export function cachedUpdateMatches(candidate: CachedUpdate | undefined, selected: Selection) {
  return (
    candidate?.version === selected.version &&
    candidate.platform === selected.asset.platform &&
    candidate.architecture === selected.asset.architecture &&
    candidate.kind === selected.asset.kind &&
    candidate.size === selected.asset.size &&
    candidate.sha256 === selected.asset.sha256
  );
}

async function regularDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('更新缓存位置无效');
}

async function removeDownload(root: string, directory: string) {
  if (dirname(directory) !== root || !directoryPattern.test(basename(directory)))
    throw new Error('更新缓存位置无效');
  // rm removes a symbolic link itself, never its destination.
  await rm(directory, { recursive: true, force: true });
}

async function activeInstallerDirectories(root: string) {
  const protectedDirectories = new Set<string>();
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names) {
    if (!/^installer-[a-zA-Z0-9]{6}$/.test(name)) continue;
    const job = join(root, name);
    try {
      await regularDirectory(job);
      const readRecord = async (name: string) => {
        const path = join(job, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
          throw new Error('更新安装记录无效');
        return JSON.parse(await readFile(path, 'utf8'));
      };
      const { pid } = await readRecord('process.json');
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') continue;
      }
      const { packagePath } = await readRecord('config.json');
      if (typeof packagePath !== 'string' || resolve(packagePath) !== packagePath) continue;
      const directory = dirname(packagePath);
      if (
        dirname(directory) === root &&
        directoryPattern.test(basename(directory)) &&
        ['package.zip', 'package.exe'].includes(basename(packagePath))
      )
        protectedDirectories.add(directory);
    } catch {
      // Incomplete or stale job records do not own a package.
    }
  }
  return protectedDirectories;
}

export async function clearCachedUpdate(root: string, directory?: string) {
  try {
    await regularDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if ((await activeInstallerDirectories(root)).size)
    throw new Error('更新安装正在进行，请稍后重试');
  await rm(join(root, metadataName), { force: true });
  if (directory) await removeDownload(root, directory);
}

export async function restoreCachedUpdate(
  root: string,
  current: Pick<AppUpdateAsset, 'platform' | 'architecture'> & { version: string },
): Promise<CachedUpdate | undefined> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await regularDirectory(root);
  const protectedDirectories = await activeInstallerDirectories(root);
  let candidate: CachedUpdate | undefined;
  const metadataPath = join(root, metadataName);
  try {
    if (protectedDirectories.size) throw new Error('更新安装正在进行');
    const info = await lstat(metadataPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new Error('更新缓存记录无效');
    const metadata = metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
    const [directoryName, fileName, ...extra] = metadata.path.split('/');
    if (
      !directoryPattern.test(directoryName) ||
      fileName !== (metadata.kind === 'app-zip' ? 'package.zip' : 'package.exe') ||
      extra.length ||
      metadata.platform !== current.platform ||
      metadata.architecture !== current.architecture ||
      metadata.kind !== (current.platform === 'macos' ? 'app-zip' : 'nsis') ||
      compareUpdateVersions(metadata.version, current.version) <= 0
    )
      throw new Error('更新缓存记录无效');
    const directory = join(root, directoryName);
    await regularDirectory(directory);
    const packagePath = join(directory, fileName);
    await verifyUpdateFile(packagePath, metadata);
    candidate = { ...metadata, packagePath, directory };
  } catch (error) {
    if (!protectedDirectories.size && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await rm(metadataPath, { force: true });
    }
  }
  // Only directories generated by this downloader belong to startup cleanup.
  for (const name of await readdir(root)) {
    if (
      directoryPattern.test(name) &&
      join(root, name) !== candidate?.directory &&
      !protectedDirectories.has(join(root, name))
    )
      await removeDownload(root, join(root, name));
  }
  if (!candidate && !protectedDirectories.size) await rm(metadataPath, { force: true });
  await rm(join(root, metadataName + '.tmp'), { force: true });
  return candidate;
}

export async function verifyCachedUpdate(candidate: CachedUpdate, asset: AppUpdateAsset) {
  await regularDirectory(dirname(candidate.directory));
  await regularDirectory(candidate.directory);
  await verifyUpdateFile(candidate.packagePath, asset);
}

export async function saveCachedUpdate(root: string, selected: Selection, packagePath: string) {
  const directory = dirname(packagePath);
  if (dirname(directory) !== root || !directoryPattern.test(basename(directory)))
    throw new Error('更新缓存位置无效');
  await regularDirectory(root);
  await regularDirectory(directory);
  await verifyUpdateFile(packagePath, selected.asset);
  const { platform, architecture, kind, size, sha256 } = selected.asset;
  const metadata: Metadata = {
    format: 1,
    version: selected.version,
    platform,
    architecture,
    kind,
    size,
    sha256,
    path: relative(root, packagePath).split('\\').join('/'),
  };
  const temporary = join(root, metadataName + '.tmp');
  await rm(temporary, { force: true });
  await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(root, metadataName));
  return { ...metadata, packagePath, directory };
}
