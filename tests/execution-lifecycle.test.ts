import { describe, expect, it } from 'vitest';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('execution settlement priorities', () => {
  it.each([
    { unknown: true, pending: true, children: true, status: 'interrupted' },
    { unknown: false, pending: true, children: true, status: 'queued' },
    { unknown: false, pending: false, children: true, status: 'waiting_children' },
    { unknown: false, pending: false, children: false, status: 'completed' },
  ] as const)('keeps $status when settlement conditions overlap', async (condition) => {
    const { core, bot } = await setup(async (context) => {
      core.scheduler.pause();
      const storage = core.state.storage;
      const run = storage.get<Run>('runs', context.runId)!;
      const task = storage.get<Task>('tasks', run.taskId)!;
      if (condition.children) {
        storage.put('tasks', {
          ...task,
          id: 'waiting-child',
          parentId: task.id,
          goal: '等待独立成员结果',
          status: 'waiting_input',
          runIds: [],
        });
      }
      if (condition.pending)
        core.tasks.send({ conversationId: task.conversationId, content: '补充要求' });
      if (condition.unknown)
        storage.put('tool_operations', {
          id: 'unconfirmed-operation',
          runId: run.id,
          status: 'unknown',
        });
      return { text: '本轮已完成' };
    });
    const member = bot('助手');
    const room = core.entities.createConversation({
      name: '执行结果',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '完成工作' });
    await eventually(() =>
      core.state.storage
        .byField<Run>('runs', 'taskId', sent.taskIds[0])
        .some((run) => run.status === 'completed'),
    );
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({
      status: condition.status,
      result: '本轮已完成',
      reconciliationRequired: condition.unknown,
    });
    expect(
      core.state.storage.messages(room.id).filter((message) => message.authorType === 'bot'),
    ).toEqual([expect.objectContaining({ content: '本轮已完成', status: 'committed' })]);
  });

  it('keeps the content and separation of messages posted before an empty final response', async () => {
    const { core, bot } = await setup(async (context) => {
      await context.executeTool('post_message', { content: '第一项结果' }, 'first');
      await context.executeTool('post_message', { content: '第二项结果' }, 'second');
      return { text: '' };
    });
    const member = bot('助手', ['post_message']);
    const room = core.entities.createConversation({
      name: '发表结果',
      kind: 'group',
      chiefId: member.id,
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '分项回复' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.result).toBe(
      '第一项结果\n\n第二项结果',
    );
    expect(
      core.state.storage
        .messages(room.id)
        .filter((message) => message.authorType === 'bot')
        .map((message) => message.content),
    ).toEqual(['第一项结果', '第二项结果']);
  });

  it('delivers posted files once while preserving the final explanation', async () => {
    const { core, bot } = await setup(async (context) => {
      const storage = core.state.storage;
      const run = storage.get<Run>('runs', context.runId)!;
      const task = storage.get<Task>('tasks', run.taskId)!;
      const artifact: Artifact = {
        id: 'report',
        name: '报告.md',
        path: '/artifacts/report.md',
        workingPath: '/work/report.md',
        mimeType: 'text/markdown',
        sha256: 'digest',
        size: 10,
        taskId: task.id,
        botId: task.botId,
        conversationId: task.conversationId,
        createdAt: task.createdAt,
      };
      storage.put('artifacts', artifact);
      storage.put('tasks', { ...task, artifactIds: [artifact.id] });
      await context.executeTool(
        'post_message',
        { content: '文件已完成', artifactIds: [artifact.id] },
        'delivery',
      );
      return { text: '这是文件的详细说明' };
    });
    const member = bot('助手', ['post_message']);
    const room = core.entities.createConversation({
      name: '文件交付',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '制作报告' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    const replies = core.state.storage
      .messages(room.id)
      .filter((item) => item.authorType === 'bot');
    expect(replies.map((item) => [item.content, item.artifactIds])).toEqual([
      ['文件已完成', ['report']],
      ['这是文件的详细说明', []],
    ]);
  });
});
