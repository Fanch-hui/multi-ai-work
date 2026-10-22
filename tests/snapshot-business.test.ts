import { describe, expect, it, vi } from 'vitest';
import type { TaskPlanRecord } from '../src/domain/task-plan.js';
import type { Message } from '../src/domain/types.js';
import type { SnapshotDelta } from '../src/domain/snapshot-sync.js';
import { TeamSnapshotStore } from '../apps/ui/src/snapshot-store.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot } = await setup(async () => ({ text: '' }));
  core.scheduler.pause();
  const member = bot('成员');
  const room = core.entities.createConversation({
    name: '会话',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: core.state.snapshot().workspaces[0].id,
  });
  const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '任务' });
  const s = core.state.storage;
  const append = (id: string, content = id, more: Partial<Message> = {}) =>
    s.appendMessage({
      id,
      conversationId: room.id,
      content,
      authorType: 'bot',
      status: 'committed',
      artifactIds: [],
      createdAt: '',
      ...more,
    });
  return { core, s, member, room, task, append };
}

describe('业务增量投影', () => {
  it('更新任务、安排和补充输入，并保持业务唤醒与旧客户端重载', async () => {
    const { core, s, room, task, member } = await fixture();
    const child = s.put('tasks', {
      ...task,
      id: 'child',
      parentId: task.id,
      planId: task.id,
      planStepId: 'work',
      status: 'running' as const,
    });
    s.put<TaskPlanRecord>('task_plans', {
      id: task.id,
      taskId: task.id,
      conversationId: room.id,
      title: '安排',
      steps: [
        { id: 'work', title: '工作', kind: 'work', memberIds: [member.id], dependencyIds: [] },
      ],
      createdAt: '',
      updatedAt: '',
    });
    const input = {
      id: 'input',
      kind: 'user-input',
      taskId: child.id,
      botId: member.id,
      conversationId: room.id,
      messageId: 'message',
      createdAt: '',
      status: 'pending',
    };
    s.put('deliveries', input);
    core.state.changed();
    const start = core.state.sync.view(room.id);
    const notify = vi.fn();
    const unsubscribe = core.state.subscribe(notify);
    const all = vi.spyOn(s, 'all');
    s.transaction(() => {
      s.put('deliveries', { ...input, status: 'delivered' });
      core.tasks.update(child, { status: 'completed' });
    });
    const delta = (await core.request('state.changes', {
      cursor: start.cursor,
      conversationId: room.id,
      businessDeltas: true,
    })) as SnapshotDelta;
    expect(notify).toHaveBeenCalledWith('state');
    expect(delta.reset).toBeUndefined();
    expect(delta.tasks.find((item) => item.id === child.id)).toMatchObject({ status: 'completed' });
    expect(delta.taskPlans?.[0].steps[0]).toMatchObject({
      status: 'completed',
      taskIds: ['child'],
    });
    expect(delta.taskInputs).toEqual([{ ...input, status: 'delivered' }]);
    expect(
      all.mock.calls.filter(([table]) =>
        ['tasks', 'runs', 'task_plans', 'deliveries', 'conversations'].includes(table),
      ),
    ).toEqual([]);
    expect(core.state.sync.delta(start.cursor, room.id).reset).toBe(true);
    unsubscribe();
    all.mockRestore();
  });

  it('已读与并行草稿只更新受影响会话，界面持续使用增量', async () => {
    const { core, s, room, append } = await fixture();
    for (let index = 0; index < 100; index++)
      s.put('conversations', { ...room, id: `other-${index}` });
    const early = append('early', '', { status: 'draft' });
    const later = append('later');
    core.state.changed();
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
      core.request(method, params),
    );
    const store = new TeamSnapshotStore(
      request as <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
      () => {},
    );
    store.select(room.id);
    await store.refresh();
    const other = store.current().data!.conversations.find((item) => item.id === 'other-0');
    const all = vi.spyOn(s, 'all');
    await core.request('conversations.read', { id: room.id, messageIds: [later.id] });
    await store.refresh();
    expect(
      store.current().data!.conversations.find((item) => item.id === room.id)?.unreadCount,
    ).toBe(0);
    s.updateMessage({ ...early, content: '延后可见' });
    core.state.changed('content');
    await store.refresh();
    expect(
      store.current().data!.conversations.find((item) => item.id === room.id)?.unreadCount,
    ).toBe(1);
    await core.request('conversations.read', { id: room.id, messageIds: [early.id] });
    await store.refresh();
    expect(
      store.current().data!.conversations.find((item) => item.id === room.id)?.unreadCount,
    ).toBe(0);
    expect(store.current().data!.conversations.find((item) => item.id === 'other-0')).toBe(other);
    expect(request.mock.calls.filter(([method]) => method === 'state.view')).toHaveLength(1);
    expect(all).not.toHaveBeenCalled();
    all.mockRestore();
  });

  it('保留配置、删除、恢复及需求变更的完整刷新', async () => {
    const { core, s, task, room, append } = await fixture();
    core.state.changed();
    let cursor = core.state.sync.cursor();
    s.put('workspaces', { ...core.state.snapshot().workspaces[0], name: '新名称' });
    core.tasks.update(task, { status: 'running' });
    expect(core.state.sync.delta(cursor, room.id, true).reset).toBe(true);
    cursor = core.state.sync.cursor();
    core.tasks.appendInput(task, append('input', '新的要求', { authorType: 'user' }));
    expect(core.state.sync.delta(cursor, room.id, true).reset).toBe(true);
    cursor = core.state.sync.cursor();
    s.deleteMessage('input');
    core.state.changed('state', { incremental: true });
    expect(core.state.sync.delta(cursor, room.id, true).reset).toBe(true);
    cursor = core.state.sync.cursor();
    s.invalidateTables();
    core.state.changed('state', { incremental: true });
    const restored = core.state.sync.delta(cursor, room.id, true);
    expect(restored.reset).toBe(true);
    expect(restored.cursor.epoch).not.toBe(cursor.epoch);
  });
});
