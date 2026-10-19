import { describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import type { Connection, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

function heldRun() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Set<string>();
  return { release, started, run: async (context: RunContext) => {
    started.add(context.bot.id);
    await Promise.race([gate, new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))]);
    return { text: '已完成' };
  } };
}

describe('任务并发与等待原因', () => {
  it('空闲名额同时启动独立成员，只有超过全局上限的任务等待', async () => {
    const held = heldRun();
    const { core, connection, bot } = await setup(held.run);
    core.scheduler.pause();
    core.state.storage.put('connections', { ...core.state.storage.get<Connection>('connections', connection.id)!, concurrency: 10 });
    const tasks = Array.from({ length: 7 }, (_, i) => {
      const member = bot(`成员${i}`);
      const room = core.entities.createConversation({ name: `任务${i}`, kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
      return core.tasks.create({ conversationId: room.id, botId: member.id, goal: `独立工作${i}` });
    });
    core.scheduler.resume();
    await eventually(() => held.started.size === 6);
    const queued = core.state.snapshot().tasks.find(task => task.id === tasks[6].id)!;
    expect(queued).toMatchObject({ status: 'queued', queueReason: 'global_limit' });
    expect(core.state.storage.get<Task>('tasks', queued.id)?.queueReason).toBeUndefined();
    held.release();
    await eventually(() => tasks.every(task => core.state.storage.get<Task>('tasks', task.id)?.status === 'completed'));
    expect(held.started.size).toBe(7);
  });

  it('同一会话成员串行，但前置等待不阻止其他独立成员工作', async () => {
    const held = heldRun();
    const { core, connection, bot } = await setup(held.run);
    core.scheduler.pause();
    core.state.storage.setMetadata('settings', { ...core.state.settings(), maxActiveRuns: 10 });
    core.state.storage.put('connections', { ...core.state.storage.get<Connection>('connections', connection.id)!, concurrency: 5 });
    const chief = bot('Chief'), first = bot('成员甲'), next = bot('成员乙'), independent = bot('成员丙');
    const room = core.entities.createConversation({ name: '协作', kind: 'group', chiefId: chief.id,
      memberIds: [chief.id, first.id, next.id, independent.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const parent = core.tasks.create({ conversationId: room.id, botId: chief.id, goal: '统筹' });
    const create = (botId: string, dependencyIds: string[] = []) => core.tasks.create({ conversationId: room.id,
      botId, parentId: parent.id, dependencyIds, goal: '工作' });
    const working = create(first.id), serial = create(first.id), dependent = create(next.id, [working.id]), free = create(independent.id);
    core.tasks.update(parent, { status: 'waiting_children' });
    core.scheduler.resume();
    await eventually(() => held.started.has(first.id) && held.started.has(independent.id));
    const snapshot = core.state.snapshot();
    expect(snapshot.tasks.find(task => task.id === serial.id)?.queueReason).toBe('session_busy');
    expect(snapshot.tasks.find(task => task.id === dependent.id)?.queueReason).toBe('dependencies');
    expect(held.started.has(next.id)).toBe(false);
    held.release();
    await eventually(() => [working, serial, dependent, free].every(task => core.state.storage.get<Task>('tasks', task.id)?.status === 'completed'));
  });

  it('同一账号的连接共享并发额度并显示连接等待原因', async () => {
    const held = heldRun();
    const { core, connection, bot } = await setup(held.run);
    core.scheduler.pause();
    core.state.storage.setMetadata('settings', { ...core.state.settings(), maxActiveRuns: 10 });
    const current = core.state.storage.get<Connection>('connections', connection.id)!;
    core.state.storage.put('connections', { ...current, concurrency: 1, accountScope: 'test-account' });
    const second = { ...current, id: 'second-connection', concurrency: 5, accountScope: 'test-account' };
    core.state.storage.put('connections', second);
    const first = bot('成员甲');
    const next = core.entities.saveBot({ name: '成员乙', role: '成员', instructions: '', connectionId: second.id, model: 'test' });
    const create = (botId: string) => {
      const room = core.entities.createConversation({ name: '工作', kind: 'private', memberIds: [botId], workspaceId: core.state.snapshot().workspaces[0].id });
      return core.tasks.create({ conversationId: room.id, botId, goal: '工作' });
    };
    create(first.id);
    const b = create(next.id);
    core.scheduler.resume();
    await eventually(() => held.started.has(first.id));
    expect(core.state.snapshot().tasks.find(task => task.id === b.id)).toMatchObject({ status: 'queued', queueReason: 'account_limit' });
    held.release();
    await eventually(() => core.state.storage.get<Task>('tasks', b.id)?.status === 'completed');
  });
});
