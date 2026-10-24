import { describe, expect, it } from 'vitest';
import { access, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bot, Conversation, Run, Workspace } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';
import { authorizedOfficeDocument, officeOutputDirectory } from '../src/tools/office.js';
import { resolveToolWorkspace } from '../src/core/workspace-authorization.js';

async function fixture() {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const chief = core.entities.saveBot({
    ...bot('Chief', [
      'read_file',
      'list_directory',
      'write_file',
      'write_artifact',
      'run_command',
      'stop_process',
    ]),
    approvalMode: 'auto',
    memoryMode: 'off',
  });
  const home = core.state.storage.get<Conversation>(
    'conversations',
    core.state.settings().mainConversationId!,
  )!;
  const base = core.state.storage.get<Workspace>('workspaces', home.workspaceId)!;
  await mkdir(path.join(root, 'project'));
  await mkdir(path.join(root, 'reference'));
  const project = await core.entities.addWorkspace({
    name: '项目',
    path: path.join(root, 'project'),
    writable: true,
  });
  const reference = await core.entities.addWorkspace({
    name: '资料',
    path: path.join(root, 'reference'),
    writable: false,
  });
  const actor = (member: Bot, room: Conversation) => {
    const task = core.tasks.create({ botId: member.id, conversationId: room.id, goal: '处理资料' });
    const run: Run = {
      id: id(),
      botId: member.id,
      taskId: task.id,
      bindingId: id(),
      status: 'running',
      configRevision: member.revision,
      createdAt: now(),
    };
    core.state.storage.put('runs', run);
    core.tasks.update(task, { status: 'running', runIds: [run.id] });
    const context = core.tools.context(run, task, member, room, base, new AbortController().signal);
    return {
      context,
      tool: (name: string, args: Record<string, unknown>) =>
        core.tools.execute(name, args, id(), context, member),
    };
  };
  core.entities.workspaceBusy = (workspaceId) => core.tools.workspaceBusy(workspaceId);
  return { core, root, bot, chief, home, base, project, reference, actor, ...actor(chief, home) };
}

describe('项目授权与实际操作归属', () => {
  it('管家按明确项目写入，未指定时写入默认工作目录，成果保存实际项目', async () => {
    const f = await fixture();
    await f.tool('write_file', {
      workspaceId: f.project.id,
      path: 'notes.txt',
      content: '项目资料',
    });
    expect(await f.tool('write_file', { path: 'default.txt', content: '默认资料' })).toMatchObject({
      path: await realpath(path.join(f.base.path, 'default.txt')),
    });
    const artifact = await f.tool('write_artifact', {
      workspaceId: f.project.id,
      path: 'report.md',
      format: 'markdown',
      content: '交付内容',
    });
    expect(await readFile(path.join(f.project.path, 'notes.txt'), 'utf8')).toBe('项目资料');
    expect(await readFile(path.join(f.base.path, 'default.txt'), 'utf8')).toBe('默认资料');
    expect(artifact).toMatchObject({
      workspaceId: f.project.id,
      workingPath: path.join(f.project.path, 'report.md'),
    });
    expect(f.core.state.storage.get<Conversation>('conversations', f.home.id)?.workspaceId).toBe(
      f.base.id,
    );
  });

  it('读取只读项目并检索文件，写入和撤销后的读取受到当前授权约束', async () => {
    const f = await fixture();
    const target = path.join(f.reference.path, 'facts.txt');
    await writeFile(target, '已授权资料');
    expect(await f.tool('read_file', { path: target })).toMatchObject({ content: '已授权资料' });
    expect(await f.tool('list_directory', { workspaceId: f.reference.id })).toMatchObject({
      items: [expect.objectContaining({ path: 'facts.txt' })],
    });
    await expect(
      f.tool('write_file', { workspaceId: f.reference.id, path: 'new.txt', content: 'x' }),
    ).rejects.toThrow('仅允许读取');
    f.core.entities.updateWorkspace({ id: f.reference.id, enabled: false });
    await expect(f.tool('read_file', { path: target })).rejects.toThrow('撤销');
  });

  it('成员保留任务目录范围，明确项目与绝对路径均不会扩大权限', async () => {
    const f = await fixture();
    const member = f.bot('成员', ['read_file', 'write_file']);
    const room = f.core.entities.createConversation({
      name: '成员任务',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: f.base.id,
    });
    const actor = f.actor(member, room);
    await expect(
      actor.tool('read_file', { path: path.join(f.project.path, 'any.txt') }),
    ).rejects.toThrow('任务授权');
    await expect(
      actor.tool('write_file', { workspaceId: f.project.id, path: 'new.txt', content: 'x' }),
    ).rejects.toThrow('任务授权');
  });

  it('明确目录与路径不一致、符号链接跨目录均被拒绝', async () => {
    const f = await fixture();
    await expect(
      f.tool('write_file', {
        workspaceId: f.project.id,
        path: path.join(f.base.path, 'wrong.txt'),
        content: 'x',
      }),
    ).rejects.toThrow('超出');
    await symlink(f.reference.path, path.join(f.project.path, 'linked'));
    const result = await f.tool('write_file', {
      workspaceId: f.project.id,
      path: 'linked/escaped.txt',
      content: 'x',
    });
    expect(result).toMatchObject({ error: expect.stringContaining('符号链接') });
  });

  it('跨项目文档输入和输出分别解析，允许从只读目录导出到可写目录', async () => {
    const f = await fixture();
    const source = path.join(f.reference.path, 'input.docx');
    await writeFile(source, '测试占位文档');
    const args = {
      path: source,
      outputDirectory: f.project.path,
      format: 'pdf' as const,
      dpi: 144,
      purpose: 'intermediate' as const,
    };
    const selected = resolveToolWorkspace('render_document', args, f.context);
    expect(selected.workspace.id).toBe(f.project.id);
    expect(await authorizedOfficeDocument(args, selected)).toBe(source);
    expect(await officeOutputDirectory(args, source, selected)).toBe(f.project.path);
  });

  it('嵌套项目按实际目录登记成果，父目录选择不会越过子目录权限', async () => {
    const f = await fixture();
    await mkdir(path.join(f.project.path, 'nested'));
    const child = await f.core.entities.addWorkspace({
      name: '子项目',
      path: path.join(f.project.path, 'nested'),
      writable: true,
    });
    const artifact = await f.tool('write_artifact', {
      workspaceId: f.project.id,
      path: 'nested/result.md',
      format: 'markdown',
      content: '子项目成果',
    });
    expect(artifact).toMatchObject({
      workspaceId: child.id,
      workingPath: path.join(child.path, 'result.md'),
    });
    f.core.entities.updateWorkspace({ id: child.id, writable: false });
    await expect(
      f.tool('write_file', {
        workspaceId: f.project.id,
        path: 'nested/readonly.txt',
        content: 'x',
      }),
    ).rejects.toThrow('仅允许读取');
    f.core.entities.updateWorkspace({ id: child.id, enabled: false });
    await expect(
      f.tool('read_file', { workspaceId: f.project.id, path: 'nested/result.md' }),
    ).rejects.toThrow('撤销');
  });

  it('父目录命令与子项目写入串行，父子目录授权均等待实际进程退出', async () => {
    const f = await fixture();
    await mkdir(path.join(f.project.path, 'nested'));
    const child = await f.core.entities.addWorkspace({
      name: '子项目',
      path: path.join(f.project.path, 'nested'),
      writable: true,
    });
    const process = (await f.tool('run_command', {
      workspaceId: f.project.id,
      command: processExec(),
      args: ['-e', 'setInterval(() => {}, 1000)'],
      background: true,
      timeoutMs: 10000,
    })) as { processId: string };
    expect(() => f.core.entities.updateWorkspace({ id: child.id, writable: false })).toThrow(
      '正在使用',
    );
    const other = f.actor(f.chief, f.home);
    const writing = other.tool('write_file', {
      workspaceId: child.id,
      path: 'after.txt',
      content: '顺序写入',
    });
    await expect(access(path.join(child.path, 'after.txt'))).rejects.toThrow();
    await f.tool('stop_process', { processId: process.processId });
    expect(await writing).toMatchObject({ path: path.join(child.path, 'after.txt') });
    const nested = (await f.tool('run_command', {
      workspaceId: f.project.id,
      workdir: 'nested',
      command: processExec(),
      args: ['-e', 'setInterval(() => {}, 1000)'],
      background: true,
      timeoutMs: 10000,
    })) as { processId: string };
    expect(f.core.state.storage.get('processes', nested.processId)).toMatchObject({
      workspaceId: child.id,
    });
    expect(() => f.core.entities.updateWorkspace({ id: f.project.id, enabled: false })).toThrow(
      '正在使用',
    );
    await f.tool('stop_process', { processId: nested.processId });
  });

  it('命令登记实际项目，在命令退出前阻止收紧授权', async () => {
    const f = await fixture();
    const process = (await f.tool('run_command', {
      workspaceId: f.project.id,
      command: processExec(),
      args: ['-e', 'setInterval(() => {}, 1000)'],
      background: true,
      timeoutMs: 10000,
    })) as { processId: string };
    expect(process.processId).toBeDefined();
    expect(f.core.state.storage.get('processes', process.processId)).toMatchObject({
      workspaceId: f.project.id,
    });
    expect(() => f.core.entities.updateWorkspace({ id: f.project.id, enabled: false })).toThrow(
      '正在使用',
    );
    await f.tool('stop_process', { processId: process.processId });
    expect(f.core.entities.updateWorkspace({ id: f.project.id, enabled: false }).enabled).toBe(
      false,
    );
  });
});

function processExec() {
  return process.execPath;
}
