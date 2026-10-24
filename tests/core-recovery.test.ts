import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, Connection, Run, Task } from '../src/domain/types.js';
import { latestArtifactVersions } from '../src/domain/artifact-versions.js';
import { eventually, setup } from './core-harness.js';

describe('取消、对账与恢复', () => {
  it('重新授权先停止连接任务，并使旧会话绑定失效', async () => {
    const { core, root, bot, connection } = await setup(async () => ({ text: '答复' }));
    core.scheduler.pause();
    const runtime = join(root, 'agy.mjs');
    await writeFile(runtime, 'console.log("0.0.1")');
    const member = bot('助手');
    core.state.storage.put('connections', {
      ...core.state.storage.get<Connection>('connections', connection.id)!,
      provider: 'antigravity',
      status: 'error',
      error: '未找到原生运行时',
      profilePath: join(root, 'profile'),
      executable: runtime,
    });
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '排队任务' });
    const login = (await core.request('connections.login', { id: connection.id })) as {
      command: string;
      instructions: string;
    };
    expect(login.command).toContain(runtime);
    expect(login.instructions).toContain('已找到本机 agy');
    expect(core.state.storage.get<Task>('tasks', task.id)?.status).toBe('cancelled');
    expect(core.state.storage.get<Connection>('connections', connection.id)).toMatchObject({
      revision: connection.revision + 1,
      status: 'needs_auth',
    });
    expect(core.state.storage.get<Connection>('connections', connection.id)?.error).toBeUndefined();
  });
  it('审批前取消没有执行副作用，保留文件并允许重试', async () => {
    let target = '';
    const { core, root, bot } = await setup(async (context) => {
      await context.executeTool('delete_file', { path: target }, 'delete');
      return { text: '删除完成' };
    });
    const member = bot('助手', ['delete_file']);
    target = join(root, 'workspace', 'original.txt');
    await writeFile(target, '原文件');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '删除' });
    await eventually(() =>
      core.state.snapshot().approvals.some((approval) => approval.status === 'pending'),
    );
    await core.request('tasks.cancel', { id: sent.taskIds[0] });
    const task = core.state.storage.get<Task>('tasks', sent.taskIds[0])!;
    expect(task).toMatchObject({ status: 'cancelled', reconciliationRequired: false });
    expect(core.state.storage.all('tool_operations')[0]).toMatchObject({ status: 'failed' });
    expect(await readFile(target, 'utf8')).toBe('原文件');
    core.scheduler.pause();
    expect(core.tasks.retry(task.id).status).toBe('queued');
  });

  it('模型成功不能覆盖未知操作，用户核查后才解除重试限制', async () => {
    const { core, bot } = await setup(async (context) => {
      core.state.storage.put('tool_operations', {
        id: 'lost-response',
        runId: context.runId,
        status: 'unknown',
      });
      return { text: '模型答复' };
    });
    const member = bot('助手');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '执行外部操作' });
    await eventually(() => core.state.snapshot().runs[0]?.status === 'completed');
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({
      status: 'interrupted',
      reconciliationRequired: true,
    });
    expect(() => core.tasks.retry(sent.taskIds[0])).toThrow('尚未确认');
    await core.request('tasks.reconcile', { id: sent.taskIds[0], outcome: 'not_executed' });
    core.scheduler.pause();
    expect(core.tasks.retry(sent.taskIds[0]).status).toBe('queued');
  });

  it('同一绑定的第二轮不会将自己的答复重新作为群消息注入', async () => {
    const prompts: string[] = [];
    const { core, bot } = await setup(async (context) => {
      prompts.push(context.prompt);
      return { text: '首次独立答复' };
    });
    const member = bot('助手');
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const first = core.tasks.send({ conversationId: room.id, content: '第一轮' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', first.taskIds[0])?.status === 'completed',
    );
    const second = core.tasks.send({ conversationId: room.id, content: '第二轮' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', second.taskIds[0])?.status === 'completed',
    );
    expect(prompts[1]).toContain('第二轮');
    expect(prompts[1]).not.toContain('首次独立答复');
  });

  it('成果更新保留旧版本，备份恢复核查副作用且不启动排队任务', async () => {
    let calls = 0;
    const { core, bot } = await setup(async (context) => {
      calls++;
      await context.executeTool(
        'write_artifact',
        { path: 'report.md', format: 'markdown', content: '第一版' },
        'write-1',
      );
      await context.executeTool(
        'write_artifact',
        { path: 'report.md', format: 'markdown', content: '第二版' },
        'write-2',
      );
      return { text: '成果已完成' };
    });
    const member = bot('作者', ['write_artifact']);
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '生成并修改成果' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    const artifacts = core.state.snapshot().artifacts;
    expect(await readFile(artifacts[0].path, 'utf8')).toBe('第一版');
    expect(await readFile(artifacts[1].path, 'utf8')).toBe('第二版');
    core.scheduler.pause();
    const unfinished = core.tasks.create({
      conversationId: room.id,
      botId: member.id,
      goal: '中断的外部工作',
    });
    const run: Run = {
      id: 'unfinished-run',
      taskId: unfinished.id,
      botId: member.id,
      bindingId: 'old-binding',
      status: 'running',
      configRevision: 1,
      createdAt: new Date().toISOString(),
    };
    core.state.storage.put('tasks', { ...unfinished, status: 'running', runIds: [run.id] });
    core.state.storage.put('runs', run);
    core.state.storage.put('tool_operations', {
      id: 'pending-side-effect',
      runId: run.id,
      status: 'dispatched',
    });
    core.state.storage.appendMessage({
      id: 'draft',
      conversationId: room.id,
      authorType: 'bot',
      authorBotId: member.id,
      runId: run.id,
      content: '部分内容',
      artifactIds: [],
      status: 'draft',
      createdAt: run.createdAt,
    });
    const backup = (await core.request('backup.create')) as { path: string };
    core.tasks.create({ conversationId: room.id, botId: member.id, goal: '不能在恢复期间启动' });
    core.scheduler.resume();
    const restore = core.request('backup.restore', backup);
    await expect(core.request('bots.save', { input: member })).rejects.toThrow('正在恢复');
    await restore;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    expect(core.state.storage.get<Task>('tasks', unfinished.id)).toMatchObject({
      status: 'interrupted',
      reconciliationRequired: true,
    });
    expect(core.state.storage.get<Run>('runs', run.id)?.status).toBe('interrupted');
    expect(core.state.storage.messages().find((message) => message.id === 'draft')?.status).toBe(
      'interrupted',
    );
    const restored = core.state.storage.all<Artifact>('artifacts');
    expect(await readFile(restored[0].path, 'utf8')).toBe('第一版');
    expect(await readFile(restored[1].path, 'utf8')).toBe('第二版');
    expect(restored[0].workingPath).toBe(artifacts[0].workingPath);
    expect(restored[1].workingPath).toBe(artifacts[1].workingPath);
    expect(latestArtifactVersions(restored)).toHaveLength(1);
    expect(restored.map((artifact) => artifact.id)).toEqual(
      artifacts.map((artifact) => artifact.id),
    );
  });
});
