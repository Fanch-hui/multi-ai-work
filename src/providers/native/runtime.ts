import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { terminateProcessTree, waitForChildExit, waitForProcessTree } from '../../runtime/process-tree.js';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { Connection, Capabilities } from '../../domain/types.js';
import type { RunContext } from '../../domain/provider.js';

const execute = promisify(execFile);
export const nativeCapabilities = (): Capabilities => ({ runtimeKind: 'native-agent', contextOwner: 'native',
  tools: 'unverified', resume: 'unverified', imageInput: 'unverified', compaction: 'unverified',
  contextUsage: 'unverified', permissionEnforcement: 'unverified' });

export function requireProfile(connection: Connection): string {
  if (!connection.profilePath || !isAbsolute(connection.profilePath)) throw new Error('请选择 App 专用的运行时配置目录');
  const profile = resolve(connection.profilePath);
  if ([homedir(), join(homedir(), '.gemini'), join(homedir(), '.qoder')].includes(profile))
    throw new Error('请使用 App 专用目录，避免修改日常 CLI 配置');
  return profile;
}

export function runtimeEnv(profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, HOME: profile, USERPROFILE: profile, ELECTRON_RUN_AS_NODE: '1' };
}

export function commandFor(executable: string, args: string[]): { command: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(executable)) throw new Error('请选择原生可执行文件或 JavaScript CLI 入口');
  return /\.(mjs|cjs|js)$/i.test(executable) ? { command: process.execPath, args: [executable, ...args] }
    : { command: executable, args };
}

export async function runtimeVersion(executable: string, profile: string, signal: AbortSignal): Promise<string> {
  const invocation = commandFor(executable, ['--version']);
  try {
    const result = await execute(invocation.command, invocation.args, { timeout: 10000, signal,
      maxBuffer: 8192, windowsHide: true, env: runtimeEnv(profile) });
    const version = result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (!version) throw new Error();
    return version;
  } catch { signal.throwIfAborted(); throw new Error('无法读取原生 CLI 版本，请检查运行时路径'); }
}

export function launch(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const invocation = commandFor(executable, args);
  const child = spawn(invocation.command, invocation.args, { cwd, env, stdio: 'pipe', windowsHide: true,
    detached: process.platform !== 'win32' });
  // Runtime diagnostics can contain credentials; the protocol stream is the only event source.
  child.stderr.resume();
  return child;
}

const stopping = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
export function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pending = stopping.get(child);
  if (pending) return pending;
  const operation = (async () => {
    if (process.platform === 'win32') await terminateProcessTree(child, true);
    else {
      child.stdin.end();
      await waitForChildExit(child, 2000);
      await terminateProcessTree(child, true);
    }
    await waitForProcessTree(child);
  })();
  stopping.set(child, operation);
  return operation;
}

export function accountDigest(provider: string, id: string): string {
  return createHash('sha256').update(`ai-team:account:v1\0${provider}\0${id}`).digest('hex');
}

export interface Ownership { bindingId: string; connectionId: string; workspace: string; accountScope?: string; }
const ownershipPath = (profile: string, sessionId: string) => join(profile, 'ai-team-bindings', `${accountDigest('session', sessionId)}.json`);
export async function validateOwnership(context: RunContext): Promise<void> {
  if (context.binding.connectionId !== context.connection.id || context.binding.botId !== context.bot.id)
    throw new Error('原生会话绑定不匹配');
  if (context.binding.accountScope && context.connection.accountScope && context.binding.accountScope !== context.connection.accountScope)
    throw new Error('连接账号发生变化，请建立新会话');
  if (!context.binding.nativeSessionId) return;
  let previous: Ownership;
  try { previous = JSON.parse(await readFile(ownershipPath(requireProfile(context.connection), context.binding.nativeSessionId), 'utf8')); }
  catch { throw new Error('原生会话来源未验证，请建立新会话'); }
  const workspace = await realpath(context.workspacePath);
  if (previous.bindingId !== context.binding.id || previous.connectionId !== context.connection.id || previous.workspace !== workspace)
    throw new Error('原生会话工作目录或身份不匹配');
  const expected = context.binding.accountScope ?? context.connection.accountScope;
  if (expected && previous.accountScope !== expected) throw new Error('原生会话账号不匹配');
}

export async function recordOwnership(context: RunContext, sessionId: string, accountScope?: string): Promise<void> {
  const path = ownershipPath(requireProfile(context.connection), sessionId);
  await mkdir(join(requireProfile(context.connection), 'ai-team-bindings'), { recursive: true, mode: 0o700 });
  const ownership: Ownership = { bindingId: context.binding.id, connectionId: context.connection.id,
    workspace: await realpath(context.workspacePath), accountScope };
  await writeFile(path, JSON.stringify(ownership), { mode: 0o600 });
  context.persistBinding(sessionId);
}

export async function validateOwnedAccount(context: RunContext, actual: string): Promise<void> {
  const expected = context.binding.accountScope ?? context.connection.accountScope;
  if (expected && actual !== expected) throw new Error('原生运行时登录账号发生变化');
  if (!context.binding.nativeSessionId) return;
  const previous: Ownership = JSON.parse(await readFile(ownershipPath(requireProfile(context.connection), context.binding.nativeSessionId), 'utf8'));
  if (previous.accountScope !== actual) throw new Error('原生会话登录账号不匹配');
}

export async function bounded<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs = 35000): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('原生运行时控制请求超时')), timeoutMs);
    rejectAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer!); signal.removeEventListener('abort', rejectAbort); }
}
