import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { Skill } from '../domain/types.js';
import type { PresetInstallation } from '../domain/market.js';

interface ResourceFile {
  file: string;
  sha256: string;
  mode: number;
}
export interface BackupResource {
  directory: string;
  files: ResourceFile[];
  skills: { id: string; entry: string }[];
  installationIds: string[];
}
export interface RestoredResources {
  skills: Map<string, { path: string; resourceRoot: string }>;
  installations: Map<string, string>;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const excluded = (name: string) =>
  ['.git', '.aws', '.codex', '.DS_Store', 'node_modules'].includes(name) || name.startsWith('.env');

export function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
export function backupRelative(path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('备份资源路径无效');
  }
  return path;
}
export async function backupFile(root: string, file: string): Promise<string> {
  const parts = backupRelative(file).split('/');
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('备份不能包含符号链接');
  }
  if (!within(root, await realpath(path)) || !(await lstat(path)).isFile())
    throw new Error('备份资源路径越界');
  return path;
}
function rows<T>(db: Database.Database, table: string): T[] {
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table)) return [];
  return (db.prepare(`SELECT payload FROM ${table}`).all() as { payload: string }[]).map((row) =>
    JSON.parse(row.payload),
  );
}

export async function collectBackupResources(
  db: Database.Database,
  dataDirectory: string,
  destination: string,
): Promise<BackupResource[]> {
  const roots = new Map<string, BackupResource>();
  const dataRoot = await realpath(dataDirectory);
  const add = async (path: string): Promise<BackupResource | undefined> => {
    let root: string;
    try {
      root = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const part = relative(dataRoot, root).split(sep);
    if (
      !within(dataRoot, root) ||
      part.length < 2 ||
      !['skills', 'presets', 'restored'].includes(part[0])
    )
      throw new Error('技能资源必须位于应用资源目录');
    let current = dataDirectory;
    for (const name of relative(dataDirectory, resolve(path)).split(sep)) {
      current = join(current, name);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('技能资源目录不能包含符号链接');
    }
    if (!(await lstat(root)).isDirectory()) throw new Error('技能资源目录无效');
    let record = roots.get(root);
    if (!record) {
      record = { directory: `resources/${roots.size}`, files: [], skills: [], installationIds: [] };
      roots.set(root, record);
    }
    return record;
  };
  for (const skill of rows<Skill>(db, 'skills').filter((item) => !item.bundled && !item.missing)) {
    const root = skill.resourceRoot ?? dirname(skill.path),
      record = await add(root);
    if (!record) continue;
    const entry = relative(await realpath(root), await realpath(skill.path))
      .split(sep)
      .join('/');
    backupRelative(entry);
    record.skills.push({ id: skill.id, entry });
  }
  for (const installation of rows<PresetInstallation>(db, 'preset_installations')) {
    if (installation.status !== 'installed' || !installation.directory) continue;
    const record = await add(installation.directory);
    if (record) record.installationIds.push(installation.id);
  }
  for (const [root, record] of roots) {
    const limit = record.installationIds.length
      ? { bytes: 256 * 1024 * 1024, files: 5000 }
      : { bytes: 64 * 1024 * 1024, files: 1000 };
    await copyResource(root, join(destination, record.directory), record.files, limit);
    for (const skill of record.skills)
      if (!record.files.some((file) => file.file === skill.entry))
        throw new Error('备份缺少技能入口文件');
  }
  return [...roots.values()];
}

async function copyResource(
  root: string,
  destination: string,
  files: ResourceFile[],
  limit: { bytes: number; files: number },
) {
  let bytes = 0;
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      const path = join(directory, entry.name),
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('备份技能资源不能包含符号链接');
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error('备份技能资源只能包含普通文件');
      bytes += stat.size;
      if (bytes > limit.bytes || files.length >= limit.files)
        throw new Error('备份技能资源超过大小限制');
      const file = relative(root, path).split(sep).join('/'),
        target = join(destination, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
      files.push({ file, sha256: digest(await readFile(target)), mode: stat.mode & 0o777 });
    }
  };
  await mkdir(destination, { recursive: true });
  await visit(root);
}

export async function restoreBackupResources(
  root: string,
  destination: string,
  records: BackupResource[],
): Promise<RestoredResources> {
  const result: RestoredResources = { skills: new Map(), installations: new Map() };
  const seen = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (
      !Array.isArray(record.files) ||
      !Array.isArray(record.skills) ||
      !Array.isArray(record.installationIds)
    )
      throw new Error('备份资源清单无效');
    const sourceRoot = backupRelative(record.directory);
    if (!sourceRoot.startsWith('resources/') || seen.has(sourceRoot))
      throw new Error('备份资源目录无效');
    seen.add(sourceRoot);
    const targetRoot = join(destination, 'resources', String(index));
    await mkdir(targetRoot, { recursive: true });
    let bytes = 0;
    const limit = record.installationIds.length
      ? { bytes: 256 * 1024 * 1024, files: 5000 }
      : { bytes: 64 * 1024 * 1024, files: 1000 };
    const fileNames = new Set<string>();
    if (record.files.length > limit.files) throw new Error('备份资源数量超过限制');
    for (const file of record.files) {
      const name = backupRelative(file.file);
      if (name.split('/').some(excluded)) throw new Error('备份资源包含不支持的文件');
      if (fileNames.has(name)) throw new Error('备份资源文件重复');
      fileNames.add(name);
      const source = await backupFile(root, `${sourceRoot}/${name}`);
      bytes += (await lstat(source)).size;
      if (bytes > limit.bytes || digest(await readFile(source)) !== file.sha256)
        throw new Error('备份技能资源校验失败');
      const target = join(targetRoot, name);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      await chmod(target, Number.isInteger(file.mode) ? file.mode & 0o777 : 0o600);
    }
    for (const skill of record.skills) {
      if (!fileNames.has(backupRelative(skill.entry)) || result.skills.has(skill.id))
        throw new Error('备份技能入口无效');
      result.skills.set(skill.id, {
        path: resolve(targetRoot, skill.entry),
        resourceRoot: targetRoot,
      });
    }
    for (const id of record.installationIds) {
      if (result.installations.has(id)) throw new Error('备份预设资源重复');
      result.installations.set(id, targetRoot);
    }
  }
  return result;
}
