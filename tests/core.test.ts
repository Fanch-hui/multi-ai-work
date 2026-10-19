import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot, Run, Task } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import { resources, setup, eventually } from './core-harness.js';

describe('Core 持久状态和调度', () => {
  it('Chief 输出失败后等待已派任务，继续汇总不会重复派单', async () => {
    let worker!: Bot;
    let chiefRuns = 0;
    let childId = '';
    const { core, bot } = await setup(async (context) => {
      if (context.bot.name !== 'Chief') return { text: '已完成研究' };
      const child = (await context.executeTool(
        'delegate_task',
        { botId: worker.id, goal: '研究资料', expectedOutput: '证据' },
        `delegate-${++chiefRuns}`,
      )) as Task;
      if (!childId) {
        childId = child.id;
        throw new Error('模型流中断');
      }
      expect(child.id).toBe(childId);
      expect(context.prompt).toContain('已完成研究');
      if (chiefRuns === 2) throw new Error('汇总流中断');
      return { text: '已汇总研究成果' };
    });
    const chief = bot('Chief', ['delegate_task']);
    worker = bot('研究员');
    const room = core.entities.createConversation({
      name: '团队',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, worker.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '完成研究',
      targetBotIds: [chief.id],
    });
    await eventually(
      () =>
        chiefRuns === 2 &&
        core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'failed',
    );
    expect(core.tasks.retry(sent.taskIds[0]).id).toBe(sent.taskIds[0]);
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(chiefRuns).toBe(3);
    expect(core.state.snapshot().tasks).toHaveLength(2);
    expect(
      core.state
        .snapshot()
        .runs.filter((run) => run.botId === chief.id)
        .map((run) => run.status),
    ).toEqual(['failed', 'failed', 'completed']);
  });
  it('单账号单并发释放 Chief 名额，子任务完成后只唤醒一次', async () => {
    let chiefRuns = 0;
    let researcher!: Bot;
    let writer!: Bot;
    const { core, bot } = await setup(async (context) => {
      if (context.bot.name !== 'Chief') return { text: `${context.bot.name}成果` };
      chiefRuns++;
      if (chiefRuns === 1) {
        await context.executeTool(
          'delegate_task',
          { botId: researcher.id, goal: '研究', expectedOutput: '资料' },
          'delegate-r',
        );
        await context.executeTool(
          'delegate_task',
          { botId: writer.id, goal: '写作', expectedOutput: '草案' },
          'delegate-w',
        );
        return { text: '已安排两个子任务' };
      }
      expect(context.prompt).toContain('研究员成果');
      expect(context.prompt).toContain('撰稿人成果');
      return { text: '汇总完成' };
    });
    const chief = bot('Chief', ['delegate_task']);
    researcher = bot('研究员');
    writer = bot('撰稿人');
    const room = core.entities.createConversation({
      name: '团队',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, researcher.id, writer.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({
      conversationId: room.id,
      content: '完成工作',
      targetBotIds: [chief.id],
      requestId: 'same-request',
    });
    expect(
      core.tasks.send({
        conversationId: room.id,
        content: '完成工作',
        targetBotIds: [chief.id],
        requestId: 'same-request',
      }),
    ).toEqual(sent);
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(chiefRuns).toBe(2);
    expect(core.state.snapshot().tasks).toHaveLength(3);
    expect(
      core.state.snapshot().messages.filter((message) => message.authorType === 'user'),
    ).toHaveLength(1);
    expect(core.state.snapshot().runs.every((run) => run.status === 'completed')).toBe(true);
  });

  it('不同账号的研究任务真实并行，同一会话 turn 不重叠', async () => {
    let active = 0;
    let maximum = 0;
    const { core, bot, connection } = await setup(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active--;
      return { text: '结果' };
    });
    const first = bot('甲');
    const secondConnection = { ...connection, id: 'second', status: 'ready' as const };
    core.state.storage.put('connections', secondConnection);
    const second = core.entities.saveBot({
      name: '乙',
      role: '',
      instructions: '',
      connectionId: 'second',
      model: 'test',
      toolNames: [],
    });
    const room = core.entities.createConversation({
      name: '并行',
      kind: 'group',
      chiefId: first.id,
      memberIds: [first.id, second.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    core.tasks.send({
      conversationId: room.id,
      content: '并行处理',
      targetBotIds: [first.id, second.id],
    });
    await eventually(() =>
      core.state.snapshot().tasks.every((task) => task.status === 'completed'),
    );
    expect(maximum).toBe(2);
  });

  it('拒绝删除审批保留原文件，审批状态与真实运行一致', async () => {
    let original = '';
    const { core, root, bot } = await setup(async (context) => {
      const result = await context.executeTool('delete_file', { path: original }, 'delete-1');
      expect(result).toHaveProperty('error');
      return { text: '删除被拒绝，保留原文件。' };
    });
    const member = bot('操作者', ['delete_file']);
    original = join(root, 'workspace', 'original.txt');
    await writeFile(original, '保留');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '删除文件' });
    await eventually(() =>
      core.state.snapshot().approvals.some((approval) => approval.status === 'pending'),
    );
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status).toBe('waiting_approval');
    core.approvals.resolve(core.state.snapshot().approvals[0].id, false);
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(await readFile(original, 'utf8')).toBe('保留');
    expect(core.state.snapshot().approvals[0].status).toBe('rejected');
  });

  it('当前权限收紧立即阻止运行快照中的工具', async () => {
    const { core, bot } = await setup(async (context) => {
      core.entities.saveBot({ ...context.bot, toolNames: [] });
      await expect(context.executeTool('read_messages', {}, 'read-1')).rejects.toThrow('未授权');
      return { text: '权限已收紧' };
    });
    const member = bot('助手', ['read_messages']);
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '读取' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.all('tool_operations')).toHaveLength(0);
  });

  it('重新启动将未确认工具标记 unknown，不自动重做', async () => {
    let calls = 0;
    const first = await setup(async () => {
      calls++;
      return { text: '结果' };
    });
    const member = first.bot('助手');
    const room = first.core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: first.core.state.snapshot().workspaces[0].id,
    });
    const task = first.core.tasks.create({
      conversationId: room.id,
      botId: member.id,
      goal: '外部工作',
    });
    first.core.state.storage.put('tasks', { ...task, status: 'running' });
    const run: Run = {
      id: 'crashed-run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      configRevision: 1,
      createdAt: new Date().toISOString(),
    };
    first.core.state.storage.put('runs', run);
    first.core.state.storage.put('tool_operations', {
      id: 'operation',
      runId: run.id,
      status: 'dispatched',
    });
    await first.core.close();
    resources.splice(
      resources.findIndex((item) => item.core === first.core),
      1,
    );
    const second = new CoreService(first.root, undefined, undefined, []);
    resources.push({ core: second, root: first.root });
    await second.start();
    expect(second.state.storage.get<Task>('tasks', task.id)).toMatchObject({
      status: 'interrupted',
      reconciliationRequired: true,
    });
    expect(calls).toBe(0);
    expect(() => second.tasks.retry(task.id)).toThrow('尚未确认');
  });
});
