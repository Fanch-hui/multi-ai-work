import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/core/state.js';
import { ComputerService } from '../src/core/computer-service.js';
import { TaskWaitService } from '../src/core/task-waits.js';
import type { ComputerHostRequest } from '../src/domain/computer.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import type { Task, Run } from '../src/domain/types.js';
import type { TaskWait } from '../src/domain/task-wait.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'computer-core-'));
  const state = new State(directory);
  const bot = state.snapshot().bots[0];
  const room = {
    id: 'room',
    name: 'Work',
    kind: 'private' as const,
    memberIds: [bot.id],
    workspaceId: state.snapshot().workspaces[0].id,
    createdAt: new Date().toISOString(),
  };
  state.storage.put('conversations', room);
  const waits = new TaskWaitService(state);
  const host = vi.fn<ComputerHostRequest>(async (method) => {
    if (method === 'computer.apps')
      return {
        apps: [
          { bundleId: 'com.example.Editor', name: 'Editor', pid: 7 },
          { bundleId: 'com.example.Private', name: 'Private', pid: 8 },
        ],
      };
    if (method === 'computer.observe')
      return {
        revision: 'revision-1',
        bundleId: 'com.example.Editor',
        windowId: 1,
        title: 'Work',
        elements: [],
        sensitive: false,
        screenshot: 'picture',
      };
    return { ok: true };
  });
  const service = new ComputerService(state, host, waits);
  service.start();
  cleanup.push(async () => {
    await service.close();
    state.storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  function context(index = 1) {
    const task: Task = {
      id: `task-${index}`,
      botId: bot.id,
      conversationId: room.id,
      goal: 'Write',
      expectedOutput: 'Document',
      status: 'running',
      dependencyIds: [],
      runIds: [`run-${index}`],
      artifactIds: [],
      requestId: `request-${index}`,
      depth: 0,
      createdAt: room.createdAt,
      updatedAt: room.createdAt,
    };
    const run: Run = {
      id: `run-${index}`,
      taskId: task.id,
      botId: bot.id,
      bindingId: `binding-${index}`,
      status: 'running',
      configRevision: 1,
      createdAt: room.createdAt,
    };
    state.storage.put('tasks', task);
    state.storage.put('runs', run);
    const abort = new AbortController();
    return {
      task,
      run,
      abort,
      context: {
        task,
        botId: bot.id,
        runId: run.id,
        conversation: room,
        signal: abort.signal,
        assertAuthorized: vi.fn(),
        requestApproval: vi.fn(async () => true),
        markDispatched: vi.fn(),
      } as unknown as ToolExecutionContext,
    };
  }
  async function enable(allowedBotIds = [bot.id]) {
    return service.request('computer.configure', {
      input: {
        enabled: true,
        grants: [{ bundleId: 'com.example.Editor', name: 'Editor', allowedBotIds }],
      },
    });
  }
  return { state, bot, service, host, context, enable };
}
describe('共享电脑操作权限与任务归属', () => {
  it('默认关闭，按应用和成员授权后仅列出获准应用', async () => {
    const fixture = await setup();
    const { context } = fixture.context();
    await expect(fixture.service.execute('computer_apps', {}, context)).rejects.toThrow('未获准');
    await fixture.enable();
    expect(await fixture.service.execute('computer_apps', {}, context)).toMatchObject({
      apps: [{ bundleId: 'com.example.Editor' }],
    });
    await expect(
      fixture.service.execute('computer_observe', { bundleId: 'com.example.Private' }, context),
    ).rejects.toThrow('未获准');
  });
  it('快照仅供所属任务使用，每次操作消耗版本并重新核对审批', async () => {
    const fixture = await setup();
    await fixture.enable();
    const { context } = fixture.context();
    const result = await fixture.service.execute(
      'computer_observe',
      { bundleId: 'com.example.Editor', screenshot: true },
      context,
    );
    expect(result).toMatchObject({
      content: [{ type: 'text' }, { type: 'image', data: 'picture' }],
    });
    const input = { revision: 'revision-1', action: 'click', ref: 'e1' };
    await fixture.service.execute('computer_action', input, context);
    expect(context.requestApproval).toHaveBeenCalledOnce();
    expect(context.markDispatched).toHaveBeenCalledOnce();
    await expect(fixture.service.execute('computer_action', input, context)).rejects.toThrow(
      '重新观察',
    );
  });
  it('审批等待期间撤销应用授权阻止输入', async () => {
    const fixture = await setup();
    await fixture.enable();
    const { context } = fixture.context();
    await fixture.service.execute('computer_observe', { bundleId: 'com.example.Editor' }, context);
    context.requestApproval = async () => {
      await fixture.enable([]);
      return true;
    };
    await expect(
      fixture.service.execute(
        'computer_action',
        { revision: 'revision-1', action: 'fill', ref: 'e1', text: 'Report' },
        context,
      ),
    ).rejects.toThrow('未获准');
    expect(fixture.host.mock.calls.some(([method]) => method === 'computer.action')).toBe(false);
  });
  it('共享桌面只允许一个任务，释放后唤醒资源等待', async () => {
    const fixture = await setup();
    await fixture.enable();
    const first = fixture.context();
    const second = fixture.context(2);
    await fixture.service.execute(
      'computer_observe',
      { bundleId: 'com.example.Editor' },
      first.context,
    );
    await expect(
      fixture.service.execute(
        'computer_observe',
        { bundleId: 'com.example.Editor' },
        second.context,
      ),
    ).rejects.toThrow('其他任务');
    const wait = fixture.state.storage.all<TaskWait>('task_waits')[0];
    expect(wait).toMatchObject({
      kind: 'computer-resource',
      taskId: second.task.id,
      status: 'pending',
    });
    await fixture.service.close();
    expect(fixture.state.storage.get<TaskWait>('task_waits', wait.id)?.status).toBe('resumed');
  });
  it('人工接管阻止采集，交回后重新观察才能继续', async () => {
    const fixture = await setup();
    await fixture.enable();
    const current = fixture.context();
    await fixture.service.execute(
      'computer_observe',
      { bundleId: 'com.example.Editor' },
      current.context,
    );
    await fixture.service.execute('computer_handoff', { reason: '请登录应用' }, current.context);
    await expect(
      fixture.service.execute(
        'computer_observe',
        { bundleId: 'com.example.Editor' },
        current.context,
      ),
    ).rejects.toThrow('接管');
    expect(fixture.state.storage.all<TaskWait>('task_waits')[0]).toMatchObject({
      kind: 'computer-handoff',
      status: 'pending',
    });
    await fixture.service.request('computer.resume');
    await expect(
      fixture.service.execute(
        'computer_action',
        { revision: 'revision-1', action: 'click', ref: 'e1' },
        current.context,
      ),
    ).rejects.toThrow('重新观察');
    expect(fixture.state.storage.all<TaskWait>('task_waits')[0].status).toBe('resumed');
  });
  it('取消会结束宿主在途操作并释放桌面', async () => {
    const fixture = await setup();
    await fixture.enable();
    const current = fixture.context();
    let started!: () => void;
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    let reject!: (error: Error) => void;
    fixture.host.mockImplementation(async (method) => {
      if (method === 'computer.observe')
        return new Promise((_resolve, fail) => {
          reject = fail;
          started();
        });
      if (method === 'computer.release') reject(new Error('Stopped'));
      return { ok: true };
    });
    const operation = fixture.service.execute(
      'computer_observe',
      { bundleId: 'com.example.Editor' },
      current.context,
    );
    await beginning;
    current.abort.abort();
    await expect(operation).rejects.toThrow('Stopped');
    expect(await fixture.service.request('computer.session')).toBeNull();
  });
});
