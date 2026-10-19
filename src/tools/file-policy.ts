import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import {
  resolveCanonicalRoot,
  validateExistingWorkspaceCandidate,
  workspacePath,
} from './paths.js';

export { resolveCanonicalRoot, validateExistingWorkspaceCandidate };

export const scanExclusions = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'release',
  'coverage',
  '.cache',
  '.next',
  'target',
  '.ssh',
  '.aws',
  '.gnupg',
  '.codex',
  '.agents',
];
export const credentialFileNames = ['.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials'];
const privateName =
  /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|.*\.(?:pem|p12|pfx|key))$/i;
const privateDirectories = new Set(['.ssh', '.aws', '.gnupg', '.codex', '.agents']);
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function sensitivePath(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return parts.some(
    (part) =>
      privateDirectories.has(part.toLowerCase()) ||
      credentialFileNames.includes(part.toLowerCase()) ||
      privateName.test(part),
  );
}

export function excludedFromScan(relative: string): boolean {
  return (
    sensitivePath(relative) || relative.split(/[\\/]/).some((part) => scanExclusions.includes(part))
  );
}

export async function filePath(
  input: string,
  context: ToolExecutionContext,
  create = false,
  rootReal?: string,
): Promise<string> {
  if (sensitivePath(input)) throw new Error('工具不访问凭据文件或目录');
  const root = rootReal ?? (await resolveCanonicalRoot(context.workspace.path));
  const target = await workspacePath(input, context, create, root);
  if (sensitivePath(path.relative(root, target))) throw new Error('工具不访问凭据文件或目录');
  return target;
}

export function fileVersion(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readFileBytes(target: string): Promise<Buffer> {
  const info = await stat(target);
  if (!info.isFile()) throw new Error('目标不是普通文件');
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 25 MiB 读取限制');
  return readFile(target);
}

export async function observedVersion(
  target: string,
  context: ToolExecutionContext,
): Promise<string> {
  const version = fileVersion(await readFileBytes(target));
  if (context.getObservedFileVersion?.(target) !== version)
    throw new Error('请先读取文件；文件版本已变化时须重新读取');
  return version;
}

export async function existingVersion(
  target: string,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  try {
    return await observedVersion(target, context);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function approveFileChange(
  target: string,
  version: string,
  tool: string,
  context: ToolExecutionContext,
): Promise<void> {
  if (!context.workspace.writable) throw new Error('工作目录仅允许读取');
  if (
    !context.ownsFile?.(target, version) &&
    !(await context.requestApproval(tool, `修改文件：${path.basename(target)}`, {
      path: target,
      version,
    }))
  ) {
    throw new Error('修改文件未获批准');
  }
  context.signal.throwIfAborted();
  const current = await filePath(target, context);
  if (current !== target || fileVersion(await readFileBytes(current)) !== version)
    throw new Error('文件版本已变化，请重新读取');
}
