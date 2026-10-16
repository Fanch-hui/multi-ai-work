import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function withinDirectory(root: string, path: string) {
  const rest = relative(root, path);
  return rest === '' || rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

async function canonicalPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let parent = path;
  while (true) {
    try { return join(await realpath(parent), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) throw error;
      suffix.push(basename(parent)); parent = dirname(parent);
    }
  }
}

export async function requireEmptyDirectory(path: string) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(path)).length)
      throw new Error('请选择新建或空文件夹，现有文件不会被覆盖');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function validateDataDirectory(source: string, input: string) {
  if (typeof input !== 'string' || !input.trim() || !isAbsolute(input.trim()))
    throw new Error('请输入数据目录的完整路径');
  const target = resolve(input.trim());
  await requireEmptyDirectory(target);
  const [oldRoot, newRoot] = await Promise.all([realpath(source), canonicalPath(target)]);
  if (withinDirectory(oldRoot, newRoot) || withinDirectory(newRoot, oldRoot))
    throw new Error('新目录不能是当前数据目录，也不能位于它的上级或下级');
  return { target, roots: [...new Set([resolve(source), oldRoot])] };
}

export function relocatePath(value: unknown, roots: string[], target: string): unknown {
  if (typeof value !== 'string' || !isAbsolute(value)) return value;
  const root = roots.find(root => withinDirectory(root, value));
  return root ? join(target, relative(root, value)) : value;
}
