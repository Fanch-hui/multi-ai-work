import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { runAntigravitySession } from '../src/providers/native/antigravity-session.js';

const execute = promisify(execFile);
const folders: string[] = [],
  processes: number[] = [];

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

afterEach(async () => {
  for (const pid of processes.splice(0)) {
    if (await executing(pid)) process.kill(pid, 'SIGKILL');
  }
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(mode: 'holding' | 'missing-result' | 'nonzero-exit') {
  const folder = await mkdtemp(join(tmpdir(), 'ai-agy-session-'));
  folders.push(folder);
  const executable = join(folder, 'fixture.mjs'),
    pidPath = join(folder, 'processes.json');
  await writeFile(
    executable,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
const send = value => console.log(JSON.stringify(value));
function ready(descendant) {
  writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, ...(descendant ? [descendant] : [])]));
  send({event:'init', conversation_id:'fixture', init:{cwd:process.cwd(),tools:[],permission_mode:'default'}});
  createInterface({input:process.stdin}).once('line', () => {
    send({event:'step_update',step_update:{conversation_id:'fixture',step_index:0,
      step_type:'agent_response',text_delta:'Complete answer'}});
    if (mode === 'missing-result') return process.exit(0);
    const result = {event:'result',result:{conversation_id:'fixture',status:'SUCCESS',
      response:'Complete answer',usage:{input_tokens:42,output_tokens:7,cache_read_tokens:12}}};
    if (mode === 'nonzero-exit')
      process.stdout.write(JSON.stringify(result)+'\\n', () => process.exit(7));
    else send(result);
  });
}
if (mode === 'holding') {
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
    {stdio:['ignore','pipe','ignore']});
  child.stdout.once('data', () => ready(child.pid));
  setInterval(() => {}, 1000);
} else ready();
`,
  );
  let pids: number[] = [];
  const observed = { text: '', success: false };
  const run = (onSuccess?: () => void) =>
    runAntigravitySession({
      executable,
      args: [],
      cwd: folder,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      prompt: 'fixture',
      signal: new AbortController().signal,
      timeoutMs: 5000,
      beforePrompt: async () => {
        pids = JSON.parse(await readFile(pidPath, 'utf8'));
        processes.push(...pids);
      },
      onEvent: (event) => {
        if (event.type === 'text') observed.text += event.data.delta;
        if (event.type === 'status' && event.data.stopReason === 'SUCCESS') {
          observed.success = true;
          onSuccess?.();
        }
      },
    });
  return { run, pids: () => pids, observed };
}

it('returns a successful turn after waiting for its holding process tree to stop', async () => {
  const session = await fixture('holding');
  let runningAtSuccess: Promise<boolean[]> | undefined;
  const result = await session.run(() => {
    runningAtSuccess = Promise.all(session.pids().map(executing));
  });
  expect(session.pids()).toHaveLength(2);
  expect(await runningAtSuccess).toEqual([true, true]);
  expect(result).toMatchObject({
    text: 'Complete answer',
    nativeSessionId: 'fixture',
    usage: { source: 'reported', inputTokens: 42, outputTokens: 7, cachedInputTokens: 12 },
  });
  expect(await Promise.all(session.pids().map(executing))).toEqual([false, false]);
}, 10000);

it('rejects visible text followed by EOF without a successful terminal result', async () => {
  const session = await fixture('missing-result');
  await expect(session.run()).rejects.toThrow('Antigravity 输出流在最终结果前结束');
  expect(session.observed).toEqual({ text: 'Complete answer', success: false });
  expect(await Promise.all(session.pids().map(executing))).toEqual([false]);
});

it('rejects a successful terminal result followed by an explicit nonzero process exit', async () => {
  const session = await fixture('nonzero-exit');
  await expect(session.run()).rejects.toThrow('Antigravity CLI 未正常结束当前轮次');
  expect(session.observed).toEqual({ text: 'Complete answer', success: true });
  expect(await Promise.all(session.pids().map(executing))).toEqual([false]);
});
