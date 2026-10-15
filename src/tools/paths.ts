import { realpath, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function workspacePath(input: string, context: ToolExecutionContext, create = false): Promise<string> {
  const root = await realpath(context.workspace.path);
  const target = path.resolve(root, input);
  if (!within(root, target) && !within(path.resolve(context.workspace.path), target)) throw new Error('路径超出授权工作目录');
  let current = target;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (!within(root, canonical)) throw new Error('符号链接指向授权目录外');
      const resolved = path.join(canonical, path.relative(current, target));
      if (!within(root, resolved)) throw new Error('路径超出授权工作目录');
      if (!create && current !== target) throw new Error('文件不存在');
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('符号链接目标不存在');
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectionError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function ensureParent(target: string): Promise<void> { await mkdir(path.dirname(target), { recursive: true }); }
