import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProbeContext } from '../src/domain/provider.js';
import { QoderAdapter } from '../src/providers/native/qoder.js';
import { runAntigravitySession } from '../src/providers/native/antigravity-session.js';
import { launch, stop } from '../src/providers/native/runtime.js';
import { waitForProcessTree } from '../src/runtime/process-tree.js';

const execute = promisify(execFile);
const children: ChildProcessWithoutNullStreams[] = [],
  folders: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(
    folders.splice(0).map((folder) =>
      // Windows may retain directory handles briefly after the exit assertions pass.
      rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'ai-native-process-'));
  folders.push(folder);
  const executable = join(folder, 'fixture.mjs');
  await writeFile(
    executable,
    `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
  { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => console.log(child.pid));
process.stdin.resume(); setInterval(() => {}, 1000);
`,
  );
  return { folder, executable };
}

async function executing(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'stat=']);
    return !!stdout.trim() && !stdout.trim().startsWith('Z');
  } catch {
    return false;
  }
}

async function startFixture() {
  const { folder, executable } = await fixture();
  const child = launch(executable, [], folder, { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
  children.push(child);
  const [data] = await once(child.stdout, 'data');
  const descendant = Number(String(data).trim());
  expect(descendant).toBeGreaterThan(0);
  return { child, descendant };
}

it('waits for a forced native parent and descendant exit before confirming stop', async () => {
  const { child, descendant } = await startFixture();
  expect(await executing(descendant)).toBe(true);
  const pending = stop(child);
  expect(stop(child)).toBe(pending);
  await pending;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(await executing(descendant)).toBe(false);
}, 10000);

it.skipIf(process.platform === 'win32')(
  'cleans a signalled parent group while preserving another native session',
  async () => {
    const first = await startFixture(),
      second = await startFixture();
    const exited = once(first.child, 'exit');
    first.child.kill('SIGTERM');
    await exited;
    await stop(first.child);
    expect(await executing(first.descendant)).toBe(false);
    expect(await executing(second.child.pid!)).toBe(true);
    expect(await executing(second.descendant)).toBe(true);
  },
);

it.skipIf(process.platform === 'win32')(
  'verifies actual group members when its signal probe is denied',
  async () => {
    const { child, descendant } = await startFixture();
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    const kill = process.kill.bind(process);
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === 0)
        throw Object.assign(new Error('fixture-probe-denied'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    try {
      await expect(waitForProcessTree(child, 50)).rejects.toThrow('原生运行时子进程尚未退出');
      expect(await executing(descendant)).toBe(true);
      await stop(child);
      expect(await executing(descendant)).toBe(false);
    } finally {
      probe.mockRestore();
    }
  },
);

it('does not confirm an Antigravity cancellation while its descendant is still running', async () => {
  const { folder, executable } = await fixture(),
    controller = new AbortController();
  await writeFile(
    executable,
    `import { spawn } from 'node:child_process';
const send = value => console.log(JSON.stringify(value));
send({event:'init',conversation_id:'fixture',init:{cwd:process.cwd(),tools:[],permission_mode:'default'}});
const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
  { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => send({event:'step_update',step_update:{conversation_id:'fixture',
  step_index:0,step_type:'agent_response',text_delta:String(child.pid)}}));
process.stdin.resume(); setInterval(() => {}, 1000);
`,
  );
  let descendant = 0;
  try {
    await expect(
      runAntigravitySession({
        executable,
        args: [],
        cwd: folder,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        prompt: 'fixture',
        signal: controller.signal,
        timeoutMs: 5000,
        beforePrompt: async () => {},
        onEvent: (event) => {
          if (event.type === 'text') {
            descendant = Number(event.data.delta);
            controller.abort(new Error('fixture-cancelled'));
          }
        },
      }),
    ).rejects.toThrow('fixture-cancelled');
    expect(descendant).toBeGreaterThan(0);
    expect(await executing(descendant)).toBe(false);
  } finally {
    if (descendant && (await executing(descendant))) process.kill(descendant, 'SIGKILL');
  }
});

it('waits for Qoder registered processes even when SDK close only closes the protocol', async () => {
  const { folder, executable } = await fixture();
  let child!: ChildProcessWithoutNullStreams,
    descendant = 0;
  const sdk = {
    accessToken: () => ({}),
    ProcessTransport: { default: {} },
    query: ({ options }: { options: QoderSdk.Options }) => {
      child = options.spawnQoderCLIProcess!({
        command: process.execPath,
        args: [executable],
        cwd: folder,
        env: process.env,
        signal: new AbortController().signal,
      }) as ChildProcessWithoutNullStreams;
      children.push(child);
      const ready = once(child.stdout, 'data').then(([data]) => {
        descendant = Number(String(data).trim());
      });
      let closed!: () => void;
      const close = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const iterator = (async function* () {
        await ready;
        yield { type: 'system', subtype: 'init' };
        await close;
      })();
      return Object.assign(iterator, {
        initializationResult: async () => {
          await ready;
          return { capabilities: [] };
        },
        accountInfo: async () => ({ userId: 'fixture-user' }),
        getAvailableModels: async () => [],
        close: async () => closed(),
      });
    },
  } as unknown as typeof QoderSdk;
  const adapter = new QoderAdapter(async () => sdk);
  const context = {
    signal: AbortSignal.timeout(10000),
    getSecret: async () => 'fixture-token',
    connection: { provider: 'qoder', authMode: 'pat', secretRef: 'fixture', profilePath: folder },
  } as ProbeContext;
  await adapter.probe(context);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(await executing(descendant)).toBe(false);
  await adapter.close();
}, 10000);
