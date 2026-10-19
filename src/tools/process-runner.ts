import { spawn } from 'node:child_process';
import type { CommandInput } from '../domain/tools.js';
import { terminateProcessTree } from '../runtime/process-tree.js';

export interface CommandOutcome {
  status: 'completed' | 'failed' | 'stopped' | 'timed_out';
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function commandTimeout(input: CommandInput) {
  const timeout = input.timeoutMs ?? (input.background ? 600_000 : 60_000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1_800_000)
    throw new Error('命令超时必须在 1 至 1800000 毫秒之间');
  return timeout;
}

export function startCommand(
  input: CommandInput,
  cwd: string,
  onOutput: (stream: 'stdout' | 'stderr', text: string) => void,
  abort: AbortSignal,
  environment?: NodeJS.ProcessEnv,
) {
  const timeout = commandTimeout(input);
  abort.throwIfAborted();
  const child = spawn(input.command, input.args, {
    cwd,
    shell: false,
    detached: process.platform !== 'win32',
    env: environment ?? {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      LANG: 'zh_CN.UTF-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let requested: 'stopped' | 'timed_out' | undefined;
  let spawnError: Error | undefined;
  let finished = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let windowsTermination: Promise<void> | undefined;
  const terminate = (force: boolean) => {
    if (process.platform === 'win32') {
      windowsTermination ??= terminateProcessTree(child, force);
      return;
    }
    terminateProcessTree(child, force);
  };
  const stop = (reason: 'stopped' | 'timed_out' = 'stopped') => {
    if (finished || requested) return;
    requested = reason;
    terminate(false);
    forceTimer = setTimeout(() => terminate(true), 2_000);
  };
  const cancel = () => stop();
  abort.addEventListener('abort', cancel, { once: true });
  if (abort.aborted) cancel();
  const timer = setTimeout(() => stop('timed_out'), timeout);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => onOutput('stdout', text));
  child.stderr.on('data', (text) => onOutput('stderr', text));
  child.once('error', (error) => {
    spawnError = error;
  });
  const done = new Promise<CommandOutcome>((resolve) =>
    child.once('close', async (code, signal) => {
      finished = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      abort.removeEventListener('abort', cancel);
      if (process.platform !== 'win32') terminate(true);
      await windowsTermination;
      resolve({
        code,
        signal,
        status: requested ?? (spawnError || code !== 0 ? 'failed' : 'completed'),
        error: spawnError,
      });
    }),
  );
  return { pid: child.pid, done, stop };
}
