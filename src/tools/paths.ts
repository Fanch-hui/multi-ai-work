import { realpath, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';

export function workspaceForPath(input: string, context: ToolExecutionContext, write = false) {
  const workspace =
    context.resolveWorkspace?.(
      path.isAbsolute(input) ? undefined : context.workspace.id,
      input,
      write,
    ) ?? context.workspace;
  return { ...context, workspace };
}

export function hasWritableWorkspace(context: ToolExecutionContext) {
  return (
    context.authorizedWorkspaces?.some((item) => item.enabled !== false && item.writable) ??
    context.workspace.writable
  );
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export async function resolveCanonicalRoot(workspaceDir: string): Promise<string> {
  return realpath(workspaceDir);
}

export async function validateExistingWorkspaceCandidate(
  rootReal: string,
  workspaceDir: string,
  candidatePath: string,
): Promise<string> {
  const target = path.resolve(rootReal, candidatePath);
  if (!within(rootReal, target) && !within(path.resolve(workspaceDir), target))
    throw new Error('路径超出授权工作目录');
  const canonical = await realpath(target);
  if (!within(rootReal, canonical)) throw new Error('符号链接指向授权目录外');
  return canonical;
}

export async function workspacePath(
  input: string,
  context: ToolExecutionContext,
  create = false,
  rootReal?: string,
): Promise<string> {
  context = workspaceForPath(input, context);
  const root = rootReal ?? (await resolveCanonicalRoot(context.workspace.path));
  const target = path.resolve(root, input);
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

export async function ensureParent(target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
}
