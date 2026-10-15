import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection, ProcessRecord, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

const command = { command: process.execPath, args: ['-e', 'console.log("started"); setInterval(() => {}, 1000)'], background: true };

describe('Core 任务命令边界', () => {
  it('失败命令的退出码和输出独立保留，不将正常返回的工具结果伪装成命令成功', async () => {
    const { core, bot } = await setup(async context => {
      const result = await context.executeTool('run_command', { command: process.execPath,
        args: ['-e', 'console.error("生成脚本出错"); process.exit(1)'] }, 'failed-command') as { status: string; code: number };
      expect(result).toMatchObject({ status: 'failed', code: 1 });
      return { text: '命令失败，已保留诊断' };
    });
    const member = bot('助手', ['run_command']);
    core.entities.saveBot({ ...member, approvalMode: 'auto' });
    const room = core.entities.createConversation({ name: '命令', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '执行' });
    await eventually(() => core.state.storage.get<Task>('tasks', task.id)?.status === 'completed');
    const record = core.state.storage.all<ProcessRecord>('processes')[0];
    expect(await core.request('processes.output', { id: record.id })).toMatchObject({ stderr: '生成脚本出错\n' });
    expect(core.state.storage.events().find(event => event.type === 'tool' && event.data.status === 'completed')?.data)
      .toMatchObject({ commandStatus: 'failed', exitCode: 1 });
  });

  it('其他成员的后台命令占用工作目录时等待结束后写入，而非制造工具失败', async () => {
    let runnerId = '';
    const { core, bot, root, connection } = await setup(async context => {
      if (context.bot.id === runnerId) {
        await context.executeTool('run_command', { command: process.execPath,
          args: ['-e', 'setTimeout(() => console.log("done"), 400)'], background: true }, 'start');
        await eventually(() => !core.tools.processes.hasActiveRun(context.runId));
      } else {
        await eventually(() => core.tools.processes.hasActive());
        const result = await context.executeTool('write_file', { path: 'shared-result.txt', content: 'ready' }, 'write');
        expect(result).not.toHaveProperty('error');
      }
      return { text: '完成' };
    });
    core.scheduler.pause();
    core.state.storage.put('connections', { ...core.state.storage.get<Connection>('connections', connection.id)!, concurrency: 2 });
    const runner = bot('命令成员', ['run_command']), writer = bot('文件成员', ['write_file']);
    for (const member of [runner, writer]) core.entities.saveBot({ ...member, approvalMode: 'auto' });
    runnerId = runner.id;
    const tasks = [runner, writer].map(member => {
      const room = core.entities.createConversation({ name: member.name, kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
      return core.tasks.create({ conversationId: room.id, botId: member.id, goal: '独立工作' });
    });
    core.scheduler.resume();
    await eventually(() => tasks.every(task => core.state.storage.get<Task>('tasks', task.id)?.status === 'completed'));
    expect(await readFile(join(root, 'workspace', 'shared-result.txt'), 'utf8')).toBe('ready');
    expect(core.state.storage.all<ProcessRecord>('processes')[0].status).toBe('completed');
  });

  it('等待其他成员写锁时可立即取消，之后不补执行已取消的写入', async () => {
    let runnerId = '';
    const { core, bot, root, connection } = await setup(async context => {
      if (context.bot.id === runnerId) await context.executeTool('run_command', {
        command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }, 'start');
      else {
        await eventually(() => core.tools.processes.hasActive());
        await context.executeTool('write_file', { path: 'cancelled-result.txt', content: 'cancelled' }, 'write');
      }
      return { text: '完成' };
    });
    core.scheduler.pause();
    core.state.storage.put('connections', { ...core.state.storage.get<Connection>('connections', connection.id)!, concurrency: 2 });
    const runner = bot('命令成员', ['run_command']), writer = bot('文件成员', ['write_file']);
    for (const member of [runner, writer]) core.entities.saveBot({ ...member, approvalMode: 'auto' });
    runnerId = runner.id;
    const tasks = [runner, writer].map(member => {
      const room = core.entities.createConversation({ name: member.name, kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
      return core.tasks.create({ conversationId: room.id, botId: member.id, goal: '工作' });
    });
    core.scheduler.resume();
    await eventually(() => core.state.storage.all<{ name: string; status: string }>('tool_operations').some(operation => operation.name === 'write_file' && operation.status === 'prepared'));
    await core.scheduler.cancel(tasks[1].id);
    expect(core.tools.processes.hasActive()).toBe(true);
    expect(core.state.storage.get<Task>('tasks', tasks[1].id)?.status).toBe('cancelled');
    await core.scheduler.cancel(tasks[0].id);
    await expect(access(join(root, 'workspace', 'cancelled-result.txt'))).rejects.toThrow();
  });

  it('其他成员等待后台命令时，本任务先结束该命令再写入，避免循环等待', async () => {
    let runnerId = '';
    const { core, bot, root, connection } = await setup(async context => {
      if (context.bot.id === runnerId) {
        const started = await context.executeTool('run_command', command, 'start') as { processId: string };
        await eventually(() => core.state.storage.all<{ name: string; status: string }>('tool_operations')
          .some(operation => operation.name === 'write_file' && operation.status === 'prepared'));
        const blocked = await context.executeTool('write_file', { path: 'own-result.txt', content: 'too early' }, 'blocked') as { error: string };
        expect(blocked.error).toContain('活跃命令');
        await context.executeTool('stop_process', { processId: started.processId }, 'stop');
        await context.executeTool('write_file', { path: 'own-result.txt', content: 'ready' }, 'write');
      } else {
        await eventually(() => core.tools.processes.hasActive());
        await context.executeTool('write_file', { path: 'shared-result.txt', content: 'ready' }, 'write');
      }
      return { text: '完成' };
    });
    core.scheduler.pause();
    core.state.storage.put('connections', { ...core.state.storage.get<Connection>('connections', connection.id)!, concurrency: 2 });
    const runner = bot('命令成员', ['run_command', 'stop_process', 'write_file']), writer = bot('文件成员', ['write_file']);
    for (const member of [runner, writer]) core.entities.saveBot({ ...member, approvalMode: 'auto' });
    runnerId = runner.id;
    const tasks = [runner, writer].map(member => {
      const room = core.entities.createConversation({ name: member.name, kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
      return core.tasks.create({ conversationId: room.id, botId: member.id, goal: '独立工作' });
    });
    core.scheduler.resume();
    await eventually(() => tasks.every(task => core.state.storage.get<Task>('tasks', task.id)?.status === 'completed'));
    for (const name of ['own-result.txt', 'shared-result.txt']) expect(await readFile(join(root, 'workspace', name), 'utf8')).toBe('ready');
    expect(core.tools.processes.hasActive()).toBe(false);
  });

  it('模型结束时停止活跃命令，并将任务保留为未完成', async () => {
    const { core, bot } = await setup(async context => {
      await context.executeTool('run_command', command, 'start');
      return { text: '已经完成' };
    });
    const member = bot('助手', ['run_command']);
    const room = core.entities.createConversation({ name: '命令', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '执行命令' });
    await eventually(() => core.state.snapshot().approvals.some(item => item.status === 'pending'));
    core.approvals.resolve(core.state.snapshot().approvals[0].id, true);
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'failed');
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])!.error).toContain('任务尚未完成');
    expect(core.state.storage.all<ProcessRecord>('processes')[0].status).toBe('stopped');
    expect(core.tools.processes.hasActive()).toBe(false);
  });

  it('活跃命令阻止写入和提问，读取与停止可用，停止后恢复写入和提问', async () => {
    const { core, bot, root } = await setup(async context => {
      const started = await context.executeTool('run_command', command, 'start') as { processId: string };
      const blocked = await context.executeTool('write_file', { path: 'result.txt', content: 'too early' }, 'blocked') as { error: string };
      expect(blocked.error).toContain('活跃命令');
      const question = await context.executeTool('ask_user', { question: '继续吗？' }, 'blocked-question') as { error: string };
      expect(question.error).toContain('活跃命令');
      const list = await context.executeTool('list_directory', {}, 'read-directory') as { items: unknown[] };
      expect(Array.isArray(list.items)).toBe(true);
      const stopped = await context.executeTool('stop_process', { processId: started.processId }, 'stop') as { status: string };
      expect(stopped.status).toBe('stopped');
      await context.executeTool('write_file', { path: 'result.txt', content: 'ready' }, 'write');
      await context.executeTool('ask_user', { question: '请选择下一步' }, 'question');
      return { text: '' };
    });
    const member = bot('助手', ['run_command', 'stop_process', 'write_file', 'list_directory', 'ask_user']);
    const room = core.entities.createConversation({ name: '命令', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    core.tasks.send({ conversationId: room.id, content: '执行工作' });
    await eventually(() => core.state.snapshot().approvals.some(item => item.status === 'pending'));
    core.approvals.resolve(core.state.snapshot().approvals[0].id, true);
    await eventually(() => core.state.snapshot().runs[0]?.status === 'waiting_input');
    expect(await readFile(join(root, 'workspace', 'result.txt'), 'utf8')).toBe('ready');
    expect(core.state.snapshot().questions).toHaveLength(1);
    expect(core.tools.processes.hasActive()).toBe(false);
  });

  it('取消任务等待命令实际退出', async () => {
    const { core, bot } = await setup(async context => {
      await context.executeTool('run_command', command, 'start');
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { text: '' };
    });
    const member = bot('助手', ['run_command']);
    const room = core.entities.createConversation({ name: '命令', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '执行工作' });
    await eventually(() => core.state.snapshot().approvals.some(item => item.status === 'pending'));
    core.approvals.resolve(core.state.snapshot().approvals[0].id, true);
    await eventually(() => core.tools.processes.hasActive());
    await core.scheduler.cancel(sent.taskIds[0]);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])!.status).toBe('cancelled');
    expect(core.state.storage.all<ProcessRecord>('processes')[0].status).toBe('stopped');
    expect(core.tools.processes.hasActive()).toBe(false);
  });
});
