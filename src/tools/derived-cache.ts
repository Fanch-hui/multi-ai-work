import { lstat, mkdir, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';

export const derivedCacheBytes = 512 * 1024 * 1024;
export const derivedCacheIdleMs = 7 * 24 * 60 * 60 * 1000;
const queues = new Map<string, Promise<unknown>>();
const users = new Map<string, number>();
const maintenance = new Map<string, Promise<{ bytes: number; removedBytes: number }>>();
const cacheKeyPattern = /^[a-f0-9]{64}$/;

async function exclusive<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory);
  users.set(key, (users.get(key) ?? 0) + 1);
  const previous = queues.get(key);
  const current = (previous ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    const count = users.get(key)! - 1;
    if (count) users.set(key, count);
    else users.delete(key);
    if (queues.get(key) === current) queues.delete(key);
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('缓存目录无效');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function withDerivedCache<T>(
  entryDirectory: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!cacheKeyPattern.test(path.basename(entryDirectory))) throw new Error('缓存标识无效');
  return exclusive(entryDirectory, async () => {
    const root = path.dirname(entryDirectory);
    if (!(await directoryExists(root))) await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await directoryExists(entryDirectory))) await mkdir(entryDirectory, { mode: 0o700 });
    try {
      return await work();
    } finally {
      const now = new Date();
      await utimes(entryDirectory, now, now).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  });
}

async function treeBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) bytes += info.size;
    else if (info.isDirectory()) bytes += await treeBytes(target);
  }
  return bytes;
}

async function entries(root: string) {
  if (!(await directoryExists(root))) return [];
  const result: { directory: string; bytes: number; usedAt: number }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !cacheKeyPattern.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const info = await lstat(directory);
      if (info.isDirectory() && !info.isSymbolicLink())
        result.push({ directory, bytes: await treeBytes(directory), usedAt: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}

export async function measureDerivedCache(root: string): Promise<number> {
  return (await entries(root)).reduce((total, entry) => total + entry.bytes, 0);
}

interface CacheMaintenanceOptions {
  budgetBytes?: number;
  idleMs?: number;
  clear?: boolean;
}

export async function maintainDerivedCache(
  root: string,
  options: CacheMaintenanceOptions = {},
): Promise<{ bytes: number; removedBytes: number }> {
  const key = path.resolve(root);
  const previous = maintenance.get(key);
  const work = (previous ?? Promise.resolve()).catch(() => {}).then(() => collect(root, options));
  maintenance.set(key, work);
  try {
    return await work;
  } finally {
    if (maintenance.get(key) === work) maintenance.delete(key);
  }
}

async function collect(root: string, options: CacheMaintenanceOptions) {
  const items = (await entries(root)).sort((left, right) => left.usedAt - right.usedAt);
  let bytes = items.reduce((total, entry) => total + entry.bytes, 0);
  let removedBytes = 0;
  const cutoff = Date.now() - (options.idleMs ?? derivedCacheIdleMs);
  for (const item of items) {
    if (
      !options.clear &&
      item.usedAt > cutoff &&
      bytes <= (options.budgetBytes ?? derivedCacheBytes)
    )
      continue;
    if (users.has(path.resolve(item.directory))) continue;
    const removed = await exclusive(item.directory, async () => {
      if (!(await directoryExists(item.directory))) return 0;
      const current = await lstat(item.directory);
      if (
        !options.clear &&
        current.mtimeMs > cutoff &&
        bytes <= (options.budgetBytes ?? derivedCacheBytes)
      )
        return 0;
      const size = await treeBytes(item.directory);
      await rm(item.directory, { recursive: true, force: true });
      return size;
    });
    bytes -= removed;
    removedBytes += removed;
  }
  return { bytes, removedBytes };
}
