import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { BridgeMutations } from '../src/tools/mcp-bridge.js';

describe('Bridge durable mutation receipts', () => {
  let directory: string, workspace: string, receipts: string;
  let bridge: BridgeMutations;
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ai-team-bridge-receipts-'));
    workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    receipts = path.join(workspace, '.ai-team', 'bridge');
    bridge = new BridgeMutations();
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function context(taskId = 'task'): ToolExecutionContext {
    return {
      task: { id: taskId },
      workspace: { path: workspace },
      signal: new AbortController().signal,
    } as ToolExecutionContext;
  }

  function call(
    args: Record<string, unknown>,
    invoke: (args: Record<string, unknown>) => Promise<unknown>,
    scope = { taskId: 'task', connectionId: 'connection', toolName: 'create_task' },
  ) {
    return bridge.call({
      ...scope,
      context: context(scope.taskId),
      args,
      acceptsRequestId: true,
      validate: () => undefined,
      invoke,
    });
  }

  it('uses hashed local file names while forwarding the explicit remote ID unchanged', async () => {
    const ids = ['../../../outside', '..\\..\\..\\outside', '/absolute/request'];
    for (const id of ids) {
      await call({ client_request_id: id }, async (args) => ({
        task_id: 'remote',
        requestId: args.client_request_id,
      }));
    }
    const files = await readdir(receipts);
    expect(files).toHaveLength(ids.length);
    expect(files.every((file) => /^[a-f0-9]{64}\.json$/.test(file))).toBe(true);
    await expect(access(path.join(directory, 'outside.json'))).rejects.toThrow();
    const saved = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(path.join(receipts, file), 'utf8'))),
    );
    expect(saved.map((item) => item.result.requestId).sort()).toEqual(ids.sort());
    expect(await readdir(directory)).toEqual(['workspace']);
  });

  it('isolates concurrent and durable reuse by task, connection and tool', async () => {
    let calls = 0;
    const scopes = [
      { taskId: 'task', connectionId: 'connection', toolName: 'create_task' },
      { taskId: 'other-task', connectionId: 'connection', toolName: 'create_task' },
      { taskId: 'task', connectionId: 'other-connection', toolName: 'create_task' },
      { taskId: 'task', connectionId: 'connection', toolName: 'update_task' },
    ];
    const invoke = async () => ({ task_id: `remote-${++calls}` });
    const initial = await Promise.all(
      scopes.map((scope) => call({ client_request_id: 'same' }, invoke, scope)),
    );
    expect(calls).toBe(4);
    expect(new Set(initial.map((result) => JSON.stringify(result))).size).toBe(4);
    bridge = new BridgeMutations();
    const recovered = await Promise.all(
      scopes.map((scope) => call({ client_request_id: 'same' }, invoke, scope)),
    );
    expect(calls).toBe(4);
    expect(recovered).toEqual(initial.map((result) => ({ ...(result as object), reused: true })));
    expect(await readdir(receipts)).toHaveLength(4);
  });

  it('shares identical in-flight calls and rejects changed arguments before and after completion', async () => {
    let release!: () => void,
      started!: () => void,
      calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const invoke = async () => {
      calls++;
      started();
      await gate;
      return { task_id: 'remote' };
    };
    const first = call({ client_request_id: 'same', input: { a: 1, b: 2 } }, invoke);
    await begun;
    const second = call({ input: { b: 2, a: 1 }, client_request_id: 'same' }, invoke);
    await expect(
      call({ client_request_id: 'same', input: { a: 2, b: 2 } }, invoke),
    ).rejects.toThrow('参数已变化');
    release();
    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
    bridge = new BridgeMutations();
    await expect(
      call({ client_request_id: 'same', input: { a: 2, b: 2 } }, invoke),
    ).rejects.toThrow('参数已变化');
    expect(calls).toBe(1);
  });

  it('blocks resubmission after a remote result becomes unknown', async () => {
    let calls = 0;
    const invoke = async () => {
      calls++;
      throw new Error('connection closed');
    };
    await expect(call({ client_request_id: 'uncertain' }, invoke)).rejects.toThrow(
      'connection closed',
    );
    bridge = new BridgeMutations();
    await expect(call({ client_request_id: 'uncertain' }, invoke)).rejects.toThrow('禁止重复提交');
    expect(calls).toBe(1);
    const file = (await readdir(receipts))[0];
    expect(JSON.parse(await readFile(path.join(receipts, file), 'utf8')).state).toBe('unknown');
  });

  it('recovers generated legacy hash receipts and requires reconciliation for unscoped explicit receipts', async () => {
    await mkdir(receipts, { recursive: true });
    const args = { goal: 'work' },
      requestId = hash(['task', 'connection', 'create_task', args]);
    await writeFile(
      path.join(receipts, `${requestId}.json`),
      JSON.stringify({
        requestId,
        tool: 'create_task',
        state: 'completed',
        result: { task_id: 'old-remote' },
      }),
    );
    const invoke = async () => {
      throw new Error('must not dispatch');
    };
    await expect(call(args, invoke)).resolves.toMatchObject({
      clientRequestId: requestId,
      reused: true,
      result: { task_id: 'old-remote' },
    });
    await writeFile(
      path.join(receipts, 'legacy-id.json'),
      JSON.stringify({ requestId: 'legacy-id', tool: 'create_task', state: 'pending' }),
    );
    await expect(call({ client_request_id: 'legacy-id' }, invoke)).rejects.toThrow('禁止重复提交');
  });
});
