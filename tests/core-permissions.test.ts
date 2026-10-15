import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bot, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('Core 执行权限', () => {
  it('完整权限主管执行真实命令、覆盖和删除文件，记录操作且不创建审批', async () => {
    let original = '', removed = '';
    const { core, root, connection } = await setup(async context => {
      const output = await context.executeTool('run_command', { command: process.execPath, args: ['-e', 'process.stdout.write("permission-ok")'] }, 'command');
      expect(output).toMatchObject({ code: 0, stdout: 'permission-ok' });
      await context.executeTool('read_file', { path: original }, 'read');
      await context.executeTool('edit_file', { path: original, oldText: '旧内容', newText: '新内容' }, 'edit');
      expect(await context.executeTool('delete_file', { path: removed }, 'delete')).toHaveProperty('deleted');
      return { text: '操作完成' };
    });
    await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test', memoryMode: 'off' } });
    const chief = core.state.snapshot().bots.find(bot => bot.id === core.state.settings().mainBotId)!;
    expect(chief.approvalMode).toBe('auto');
    original = join(root, 'workspace', 'original.txt'); removed = join(root, 'workspace', 'remove.txt');
    await writeFile(original, '旧内容'); await writeFile(removed, '测试文件');
    const sent = core.tasks.send({ conversationId: core.state.settings().mainConversationId!, content: '执行测试' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(await readFile(original, 'utf8')).toBe('新内容'); await expect(readFile(removed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(core.state.snapshot().approvals).toHaveLength(0);
    expect(core.state.storage.all<{ status: string }>('tool_operations').every(operation => operation.status === 'succeeded')).toBe(true);
  });
  it('执行方式变为需审批后，使用当前权限并支持拒绝真实命令', async () => {
    let marker = '';
    const { core, root, bot } = await setup(async context => {
      expect(await context.executeTool('run_command', { command: process.execPath, args: ['-e', 'process.stdout.write("first")'] }, 'first')).toMatchObject({ code: 0 });
      core.entities.saveBot({ ...context.bot, approvalMode: 'ask' });
      expect(await context.executeTool('run_command', { command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"created")', marker] }, 'second'))
        .toHaveProperty('error');
      return { text: '第二条命令被拒绝' };
    });
    marker = join(root, 'workspace', 'not-created.txt');
    const worker = core.entities.saveBot({ ...bot('执行员', ['run_command']), approvalMode: 'auto', memoryMode: 'off' });
    const room = core.entities.createConversation({ name: '权限测试', kind: 'private', memberIds: [worker.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '执行' });
    await eventually(() => core.state.snapshot().approvals.some(approval => approval.status === 'pending'));
    const approval = core.state.snapshot().approvals[0]; core.approvals.resolve(approval.id, false);
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(core.state.snapshot().approvals[0].status).toBe('rejected');
  });
  it('普通成员即使被设成群 Chief，也不能取得主管委派和团队管理权限', async () => {
    const { core, bot } = await setup(async context => {
      await expect(context.executeTool('delegate_task', { botId: other.id, goal: '任务', expectedOutput: '' }, 'delegate')).rejects.toThrow('未授权');
      return { text: '委派被拒绝' };
    });
    const worker = bot('普通成员', ['delegate_task', 'list_bots', 'configure_bot', 'create_task_group']);
    expect(worker.toolNames).toEqual([]);
    const other = bot('其他成员');
    core.state.storage.put('bots', { ...worker, toolNames: ['delegate_task', 'list_bots'] });
    const room = core.entities.createConversation({ name: '群聊', kind: 'group', chiefId: worker.id, memberIds: [worker.id, other.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '尝试委派', targetBotIds: [worker.id] });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    core.scheduler.pause();
    const parent = core.tasks.create({ conversationId: room.id, botId: worker.id, goal: '成员任务' });
    expect(() => core.tasks.create({ conversationId: room.id, botId: other.id, parentId: parent.id, goal: '再委派' })).toThrow('只有主管');
    expect(core.state.storage.get<Bot>('bots', worker.id)).toBeDefined();
  });
  it('审批等待期间收紧文件权限，批准后也不会修改原文件', async () => {
    let original = '';
    const { core, root, bot } = await setup(async context => {
      await context.executeTool('read_file', { path: original }, 'read');
      expect(await context.executeTool('edit_file', { path: original, oldText: '保留', newText: '修改' }, 'edit')).toHaveProperty('error');
      return { text: '权限收紧后文件保持原样' };
    });
    original = join(root, 'workspace', 'original.txt'); await writeFile(original, '保留');
    const worker = bot('编辑员', ['read_file', 'edit_file']);
    const room = core.entities.createConversation({ name: '权限', kind: 'private', memberIds: [worker.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '修改' });
    await eventually(() => core.state.snapshot().approvals.some(approval => approval.status === 'pending'));
    core.entities.saveBot({ ...worker, toolNames: ['read_file'] });
    core.approvals.resolve(core.state.snapshot().approvals[0].id, true);
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    expect(await readFile(original, 'utf8')).toBe('保留');
  });
});
