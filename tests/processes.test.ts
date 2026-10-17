import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import type { ProcessRecord, Task } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { ProcessService } from '../src/core/processes.js';
import { commandTimeout } from '../src/tools/process-runner.js';
import { runCommand } from '../src/tools/process.js';

function context(directory: string, signal = new AbortController().signal): ToolExecutionContext {
  return { runId: 'run', botId: 'bot', signal,
    task: { id: 'task', conversationId: 'conversation', botId: 'bot', dependencyIds: [], goal: 'test', expectedOutput: 'output',
      status: 'running', runIds: ['run'], artifactIds: [], requestId: 'request', depth: 0, createdAt: '', updatedAt: '' },
    conversation: { id: 'conversation', name: 'Test', kind: 'group', memberIds: ['bot'], workspaceId: 'workspace', createdAt: '' },
    workspace: { id: 'workspace', name: 'Test', path: directory, writable: true }, requestApproval: async () => true,
    listArtifacts: () => [], registerArtifact: () => { throw new Error('unused'); }, findArtifact: () => undefined,
    postMessage: () => 'message', readMessages: () => [], delegateTask: () => { throw new Error('unused'); }, getTask: () => undefined,
    recallMemory: () => [], proposeMemory: () => { throw new Error('unused'); }, getSecret: async () => undefined, toolConnections: [], skills: [] };
}
const command = (script: string) => ({ command: process.execPath, args: ['-e', script] });
async function waitFor(check: () => Promise<boolean> | boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('进程状态未在预期时间内出现');
}

describe('task process management', () => {
  let directory: string, state: State, service: ProcessService, ctx: ToolExecutionContext;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ai-processes-'));
    state = new State(path.join(directory, 'state')); service = new ProcessService(state);
    ctx = context(directory); ctx.processes = service.forContext(ctx);
    state.storage.put('tasks', ctx.task);
  });
  afterEach(async () => { await service.close(); state.storage.close(); await rm(directory, { recursive: true, force: true }); });

  it('retains synchronous result fields, validates cwd and requires approval', async () => {
    await mkdir(path.join(directory, 'nested'));
    const result = await ctx.processes!.run({ ...command('console.log(process.cwd()); console.error("err")'), workdir: 'nested' }) as any;
    expect(result).toMatchObject({ status: 'completed', code: 0, signal: null, timedOut: false, stderr: 'err\n' });
    expect(result.stdout.trim()).toBe(await realpath(path.join(directory, 'nested')));
    expect(service.hasActive()).toBe(false);
    await expect(ctx.processes!.run({ ...command('process.exit(0)'), workdir: '..' })).rejects.toThrow('授权');
    ctx.requestApproval = async () => false;
    await expect(ctx.processes!.run(command('process.exit(0)'))).rejects.toThrow('批准');
    expect(ctx.processes!.list()).toHaveLength(1);
  });

  it('returns background IDs, reads stable incremental logs and rejects other task or member access', async () => {
    const started = await ctx.processes!.run({ ...command('console.log("first"); setTimeout(()=>{console.error("second");process.exit(0)},200)'), background: true }) as any;
    expect(started.processId).toBeTruthy(); expect(service.hasActiveRun('run')).toBe(true);
    let first: any;
    await waitFor(async () => { first = await ctx.processes!.read({ processId: started.processId }); return first.stdout.includes('first'); });
    const cursor = first.nextOffset;
    await waitFor(() => !service.hasActive());
    const second = await ctx.processes!.read({ processId: started.processId, offset: cursor }) as any;
    expect(second.stdout).toBe(''); expect(second.stderr).toBe('second\n'); expect(second.status).toBe('completed');
    const other = { ...ctx, botId: 'other' };
    await expect(service.forContext(other).read({ processId: started.processId })).rejects.toThrow('未授权');
    expect(service.forContext({ ...ctx, task: { ...ctx.task, id: 'other-task' } }).list()).toEqual([]);
    await expect(service.forContext(other).stop(started.processId)).rejects.toThrow('未授权');
  });

  it('times out and stops real child process trees before reporting completion', async () => {
    const script = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"]);console.log(child.pid);setInterval(()=>{},1000)';
    const result = await ctx.processes!.run({ ...command(script), timeoutMs: 200 }) as any;
    expect(result.status).toBe('timed_out'); expect(result.timedOut).toBe(true); expect(service.hasActive()).toBe(false);
    const childPid = Number(result.stdout.trim()); expect(childPid).toBeGreaterThan(0);
    await waitFor(() => { try { process.kill(childPid, 0); return false; } catch { return true; } });
  });

  it('cancels active commands and settles leftovers on model completion', async () => {
    const controller = new AbortController(); ctx.signal = controller.signal;
    const running = ctx.processes!.run(command('setInterval(()=>{},1000)'));
    await waitFor(() => service.hasActive()); controller.abort(new Error('cancelled'));
    await expect(running).rejects.toThrow('cancelled');
    expect(ctx.processes!.list()[0]).toMatchObject({ status: 'stopped' });
    ctx = context(directory); ctx.processes = service.forContext(ctx);
    await ctx.processes.run({ ...command('setInterval(()=>{},1000)'), background: true });
    expect(await service.settleRun('run')).toBe(true); expect(service.hasActive()).toBe(false);
    expect(await service.settleRun('run')).toBe(false);
  });

  it('keeps logs bounded and identifies cursor truncation', async () => {
    const result = await ctx.processes!.run(command('process.stdout.write("x".repeat(150000))')) as any;
    const read = await ctx.processes!.read({ processId: result.processId, offset: 0, limit: 60_000 }) as any;
    expect(read.truncated).toBe(true); expect(read.offset).toBe(60_000); expect(read.nextOffset).toBe(120_000);
    expect(read.stdout).toHaveLength(60_000);
    const persisted = state.storage.get<any>('processes', result.processId);
    expect(persisted.log.map((item: any) => item.text).join('')).toHaveLength(90_000);
  });

  it('waits for output, blocks concurrent workspace commands and confirms explicit stop', async () => {
    const started = await ctx.processes!.run({ ...command('setTimeout(()=>console.log("ready"),100);setInterval(()=>{},1000)'), background: true }) as any;
    await expect(ctx.processes!.run(command('process.exit(0)'))).rejects.toThrow('活跃命令');
    const output = await ctx.processes!.read({ processId: started.processId, offset: 0, waitMs: 1_000 }) as any;
    expect(output.stdout).toBe('ready\n');
    await expect(ctx.processes!.stop(started.processId)).resolves.toMatchObject({ status: 'stopped', processId: started.processId });
    expect(service.hasActive()).toBe(false);
  });

  it('records failed spawn and nonzero exit without leaving active handles', async () => {
    await expect(ctx.processes!.run({ command: path.join(directory, 'missing-command'), args: [] })).rejects.toThrow();
    const failed = await ctx.processes!.run(command('console.error("failure");process.exit(3)')) as any;
    expect(failed).toMatchObject({ status: 'failed', code: 3, stderr: 'failure\n' });
    expect(ctx.processes!.list().every((item: any) => item.status === 'failed')).toBe(true);
    expect(service.hasActive()).toBe(false);
  });

  it('recovers unknown commands and marks task reconciliation without killing saved pid', () => {
    const record: ProcessRecord = { id: 'old', runId: 'run', taskId: 'task', botId: 'bot', conversationId: 'conversation',
      workspaceId: 'workspace', command: 'old-command', args: [], status: 'running', pid: process.pid, createdAt: '' };
    state.storage.put('processes', record); service.recover();
    expect(state.storage.get<ProcessRecord>('processes', 'old')?.status).toBe('unknown');
    expect(state.storage.get<Task>('tasks', 'task')).toMatchObject({ status: 'interrupted', reconciliationRequired: true });
    expect(process.pid).toBe(record.pid);
  });

  it('retains fallback synchronous execution and timeout defaults', async () => {
    expect(commandTimeout(command(''))).toBe(60_000);
    expect(commandTimeout({ ...command(''), background: true })).toBe(600_000);
    expect(() => commandTimeout({ ...command(''), timeoutMs: 1_800_001 })).toThrow('超时');
    ctx.processes = undefined;
    await expect(runCommand(process.execPath, ['-e', 'console.log("fallback")'], ctx)).resolves.toMatchObject({ code: 0, stdout: 'fallback\n', timedOut: false });
  });

  it('coalesces high-frequency log writes while serving latest output from memory without lingering timers', async () => {
    let processPuts = 0;
    const rawPut = state.storage.put.bind(state.storage);
    state.storage.put = ((table: Parameters<typeof rawPut>[0], value: any) => {
      if (table === 'processes') processPuts++;
      return rawPut(table, value);
    }) as typeof state.storage.put;
    const script = 'let i=0;const timer=setInterval(()=>{process.stdout.write(`chunk-${i++}\\n`);if(i>=200)clearInterval(timer)},1)';
    const started = await ctx.processes!.run({ ...command(script), background: true }) as any;
    let liveRead: any;
    await waitFor(async () => {
      liveRead = await ctx.processes!.read({ processId: started.processId, limit: 60_000 });
      return liveRead.stdout.includes('chunk-0\n');
    });
    expect(service.output(started.processId)?.stdout).toContain('chunk-0\n');
    await waitFor(() => !service.hasActive());
    const putsAtCompletion = processPuts;
    expect(putsAtCompletion).toBeGreaterThanOrEqual(3);
    expect(putsAtCompletion).toBeLessThan(25);
    const persisted = state.storage.get<any>('processes', started.processId);
    expect(persisted.status).toBe('completed');
    expect(persisted.stdout).toContain('chunk-0\n');
    expect(persisted.stdout).toContain('chunk-199\n');
    expect(persisted.stdout.trim().split('\n')).toHaveLength(200);
    expect(service.output(started.processId)).toEqual({ stdout: persisted.stdout, stderr: '', truncated: false });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(processPuts).toBe(putsAtCompletion);
  });
});
