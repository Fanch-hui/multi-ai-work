import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../src/domain/types.js';
import { receivingTasks } from '../src/core/task-input-records.js';
import { setup } from './core-harness.js';

describe('会话内补充消息接收任务', () => {
  it('保持状态优先级、最新任务优先和排队补充资格', async () => {
    const { core, bot } = await setup(async () => ({ text: '' }));
    core.scheduler.pause();
    const member = bot('接收者');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    }).id;
    const base = core.tasks.create({ conversationId: room, botId: member.id, goal: '工作' });
    const put = (id: string, status: Task['status'], createdAt: string, extra = {}) =>
      core.state.storage.put('tasks', { ...base, id, status, createdAt, ...extra });
    put('waiting', 'waiting_children', '2026-10-22');
    put('old-running', 'running', '2026-10-20');
    put('new-running', 'recovering', '2026-10-21');
    put('background', 'running', '2026-10-23', { kind: 'memory-review' });
    put('finished', 'completed', '2026-10-24');
    expect(receivingTasks(core.state.storage, room).get(member.id)?.id).toBe('new-running');
    core.state.storage.delete('tasks', 'new-running');
    core.state.storage.delete('tasks', 'old-running');
    expect(receivingTasks(core.state.storage, room).get(member.id)?.id).toBe('waiting');
    core.state.storage.delete('tasks', 'waiting');
    expect(receivingTasks(core.state.storage, room).size).toBe(0);
    core.state.storage.put('deliveries', {
      id: 'supplement',
      kind: 'user-input',
      taskId: base.id,
      status: 'claimed',
    });
    expect(receivingTasks(core.state.storage, room).get(member.id)?.id).toBe(base.id);
    core.state.storage.put('deliveries', {
      id: 'supplement',
      kind: 'user-input',
      taskId: base.id,
      status: 'delivered',
    });
    expect(receivingTasks(core.state.storage, room).size).toBe(0);
  });

  it.each([1_000, 10_000])('五人群发送只读取当前会话候选，忽略 %i 条其他任务', async (count) => {
    const { core, bot } = await setup(async () => ({ text: '' }));
    core.scheduler.pause();
    const members = Array.from({ length: 5 }, (_, index) => bot(`成员 ${index}`));
    const room = core.entities.createConversation({
      name: '协作',
      kind: 'group',
      chiefId: members[0].id,
      memberIds: members.map((member) => member.id),
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const tasks = members.map((member) =>
      core.tasks.create({
        conversationId: room.id,
        botId: member.id,
        goal: '工作',
      }),
    );
    const s = core.state.storage;
    s.transaction(() => {
      for (const task of tasks) {
        s.put('deliveries', {
          id: task.id,
          taskId: task.id,
          kind: 'user-input',
          status: 'pending',
        });
      }
      for (let index = 0; index < count; index++) {
        s.put('tasks', { ...tasks[0], id: `other-${index}`, conversationId: 'other' });
        s.put('deliveries', {
          id: `other-${index}`,
          taskId: `other-${index}`,
          kind: 'user-input',
          status: 'pending',
        });
      }
    });
    const all = vi.spyOn(s, 'all');
    const selected = vi.spyOn(s, 'byField');
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '补充要求',
      requestId: 'once',
    });
    expect(sent.taskIds).toEqual(tasks.map((task) => task.id));
    expect(all.mock.calls.filter(([table]) => table === 'tasks' || table === 'deliveries')).toEqual(
      [],
    );
    const queries = selected.mock.calls.flatMap(([table, field, value], index) =>
      table === 'tasks' && field === 'conversationId' && value === room.id ? [index] : [],
    );
    expect(queries).toHaveLength(1);
    expect(selected.mock.results[queries[0]].value).toHaveLength(5);
    expect(
      core.tasks.send({ conversationId: room.id, content: '补充要求', requestId: 'once' }),
    ).toEqual(sent);
    const plan = s
      .prepare(`EXPLAIN QUERY PLAN SELECT payload FROM deliveries
      WHERE json_extract(payload, '$.taskId') IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(tasks.map((task) => task.id))) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('deliveries_by_task'))).toBe(true);
    vi.restoreAllMocks();
  });
});
