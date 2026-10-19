import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Run } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const member = bot('读取成员', ['read_file']);
  const workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({
    name: '操作记录',
    kind: 'private',
    memberIds: [member.id],
    workspaceId: workspace.id,
  });
  const task = core.tasks.create({ botId: member.id, conversationId: room.id, goal: '读取资料' });
  const run: Run = {
    id: id(),
    taskId: task.id,
    botId: member.id,
    bindingId: id(),
    status: 'running',
    configRevision: member.revision,
    createdAt: now(),
  };
  core.state.storage.put('runs', run);
  const path = join(root, 'workspace', 'source.txt');
  await writeFile(path, '原始结果');
  const context = core.tools.context(
    run,
    task,
    member,
    room,
    workspace,
    new AbortController().signal,
  );
  return {
    core,
    run,
    path,
    execute: () => core.tools.execute('read_file', { path }, 'read', context, member),
  };
}

describe('工具操作记录与派发边界', () => {
  it('重复调用使用已保存结果，原文件更新后仍保留已完成操作的结果和事件', async () => {
    const { core, run, path, execute } = await fixture();
    const result = await execute();
    expect(result).toMatchObject({ content: '原始结果' });
    await writeFile(path, '更新后的文件');
    expect(await execute()).toEqual(result);
    const events = core.state.storage
      .runEvents(run.id)
      .events.filter((event) => event.type === 'tool');
    expect(events.map((event) => event.data.status)).toEqual(['running', 'completed']);
    expect(core.state.storage.all('tool_operations')).toEqual([
      expect.objectContaining({ status: 'succeeded', result, modelResult: result }),
    ]);
  });

  it('准备记录保存失败时直接传播错误，尚未发布工具运行事件', async () => {
    const { core, run, execute } = await fixture();
    const failure = new Error('操作记录写入失败');
    const save = core.state.storage.put.bind(core.state.storage);
    const put = vi.spyOn(core.state.storage, 'put').mockImplementation((table, value) => {
      if (table === 'tool_operations') throw failure;
      return save(table, value);
    });
    try {
      await expect(execute()).rejects.toBe(failure);
      expect(core.state.storage.all('tool_operations')).toEqual([]);
      expect(
        core.state.storage.runEvents(run.id).events.filter((event) => event.type === 'tool'),
      ).toEqual([]);
    } finally {
      put.mockRestore();
    }
  });

  it('结果写入及失败结算均保存失败时传播原存储错误，准备记录保持可核查', async () => {
    const { core, run, execute } = await fixture();
    const failure = new Error('结果记录写入失败');
    const save = core.state.storage.put.bind(core.state.storage);
    const put = vi.spyOn(core.state.storage, 'put').mockImplementation((table, value) => {
      if (table === 'tool_operations' && 'status' in value && value.status !== 'prepared')
        throw failure;
      return save(table, value);
    });
    try {
      await expect(execute()).rejects.toBe(failure);
      expect(core.state.storage.all('tool_operations')).toEqual([
        expect.objectContaining({ status: 'prepared' }),
      ]);
      const events = core.state.storage
        .runEvents(run.id)
        .events.filter((event) => event.type === 'tool');
      expect(events.map((event) => event.data.status)).toEqual(['running']);
    } finally {
      put.mockRestore();
    }
  });
});
