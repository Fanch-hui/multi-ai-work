import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function terminateProcessTree(child: ChildProcess, force: boolean): Promise<void> | undefined {
  if (!child.pid) return;
  if (process.platform === 'win32') return new Promise<void>(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { child.kill(); resolve(); });
    killer.once('close', code => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    });
  });
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (exited: boolean) => {
      clearTimeout(timer); child.removeListener('exit', exitedHandler); child.removeListener('error', exitedHandler);
      resolve(exited);
    };
    const exitedHandler = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', exitedHandler); child.once('error', exitedHandler);
  });
}

async function groupIsRunning(pid: number): Promise<boolean> {
  try { process.kill(-pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code !== 'EPERM') throw error;
  }
  // A denied probe is inconclusive; only an empty group or zombies confirms exit.
  const { stdout } = await execute('ps', ['-eo', 'pgid=,stat='], { maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout.split('\n').some(line => {
    const [group, status] = line.trim().split(/\s+/);
    return Number(group) === pid && status && !status.startsWith('Z');
  });
}

export async function waitForProcessTree(child: ChildProcess, timeoutMs = 10000): Promise<void> {
  if (!await waitForChildExit(child, timeoutMs)) throw new Error('原生运行时进程尚未退出');
  if (process.platform === 'win32' || !child.pid) return;
  const deadline = Date.now() + timeoutMs;
  while (await groupIsRunning(child.pid)) {
    if (Date.now() >= deadline) throw new Error('原生运行时子进程尚未退出');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
