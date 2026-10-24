import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, Bot, Conversation, Task } from '../src/domain/types.js';
import { setup, eventually } from './core-harness.js';
import { artifactGroups } from '../apps/ui/src/artifact-groups.js';

describe('Core 常用工具', () => {
  it('成果快照保留工作来源，任务能继续更新并在库中展示最新交付版本', async () => {
    const { core, bot } = await setup(async (context) => {
      await context.executeTool(
        'write_artifact',
        { path: 'report.md', format: 'markdown', content: '初稿' },
        'first',
      );
      await context.executeTool(
        'write_artifact',
        { path: 'report.md', format: 'markdown', content: '最终成果' },
        'final',
      );
      return { text: '已完成' };
    });
    const member = bot('作者', ['write_artifact']);
    const room = core.entities.createConversation({
      name: '报告',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '交付报告' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    const snapshot = core.state.snapshot();
    expect(snapshot.approvals).toHaveLength(0);
    const files = artifactGroups(snapshot).flatMap((group) => group.artifacts);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      purpose: 'deliverable',
      source: 'write_artifact',
      botId: member.id,
    });
    expect(files[0].workingPath).toBeDefined();
    expect(await readFile(files[0].path, 'utf8')).toBe('最终成果');
  });

  it('Chief 默认能写普通文件、读取成果，后续权限调整不被默认值覆盖', async () => {
    const { core, connection, root } = await setup(async (context) => {
      await context.executeTool(
        'write_file',
        { path: 'result.json', content: '{"value":1}' },
        'create',
      );
      await context.executeTool(
        'edit_file',
        { path: 'result.json', oldText: '1', newText: '2' },
        'edit',
      );
      const artifact = (await context.executeTool(
        'register_artifact',
        { path: 'result.json' },
        'register',
      )) as Artifact;
      const result = (await context.executeTool(
        'read_artifact',
        { artifactId: artifact.id },
        'read',
      )) as { content: string };
      expect(result.content).toContain('2');
      return { text: '文件已生成并核查' };
    });
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const sent = core.tasks.send({
      conversationId: core.state.settings().mainConversationId!,
      content: '生成结果',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(await readFile(join(root, 'workspace', 'result.json'), 'utf8')).toContain('2');
    expect(core.state.snapshot().approvals).toHaveLength(0);
    const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    core.entities.saveBot({ ...chief, toolNames: ['read_file'] });
    core.state.syncMainTeam();
    expect(core.state.storage.get<Bot>('bots', chief.id)!.toolNames).toEqual(['read_file']);
  });

  it('历史搜索只查当前会话，消息锚点可读取前后文', async () => {
    const { core, bot } = await setup(async (context) => {
      const found = (await context.executeTool(
        'search_messages',
        { query: '目标资料' },
        'search',
      )) as { messageId: string; sequence: number }[];
      expect(found).toHaveLength(1);
      const around = (await context.executeTool(
        'read_messages',
        { around: found[0].sequence, limit: 3 },
        'around',
      )) as { content: string }[];
      expect(around.map((item) => item.content)).toContain('目标资料');
      expect(around.some((item) => item.content.includes('其他私聊'))).toBe(false);
      return { text: '已定位' };
    });
    const member = bot('助手', ['search_messages', 'read_messages']);
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({
      name: '资料',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const other = core.entities.createConversation({
      name: '其他',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    core.tasks.post(room.id, member.id, 'old', '目标资料');
    core.tasks.post(other.id, member.id, 'private', '目标资料来自其他私聊');
    const sent = core.tasks.send({ conversationId: room.id, content: '查历史' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
  });

  it('省略任务 ID 查询当前任务，其他私聊任务仍无法读取', async () => {
    let privateTaskId = '';
    const { core, bot } = await setup(async (context) => {
      const current = (await context.executeTool('get_task', {}, 'current')) as Task;
      expect(current.id).toBe(
        context.binding.conversationId === room.id ? sent.taskIds[0] : privateTaskId,
      );
      expect(context.prompt).toContain(`当前任务 ID：${current.id}`);
      expect(
        await context.executeTool('get_task', { taskId: privateTaskId }, 'private'),
      ).toHaveProperty('error');
      return { text: '已读取当前任务' };
    });
    const member = bot('助手', ['get_task']);
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({
      name: '当前',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    const other = core.entities.createConversation({
      name: '另一私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId,
    });
    core.scheduler.pause();
    const privateTask = core.tasks.create({
      conversationId: other.id,
      botId: member.id,
      goal: '私聊任务',
    });
    privateTaskId = privateTask.id;
    core.tasks.update(privateTask, { status: 'completed' });
    const sent = core.tasks.send({ conversationId: room.id, content: '读取当前任务' });
    core.scheduler.resume();
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
  });

  it('来源事项能核查任务群回传成果，独立事项保持资料隔离', async () => {
    let worker!: Bot, group!: { conversation: Conversation; task: Task };
    let mainRounds = 0,
      groupRounds = 0,
      artifactId = '';
    const { core, bot, connection } = await setup(async (context) => {
      if (context.bot.id === worker.id) {
        const artifact = (await context.executeTool(
          'write_artifact',
          { path: 'report.md', format: 'markdown', content: '真实群成果' },
          'write',
        )) as Artifact;
        artifactId = artifact.id;
        return { text: '已生成成果' };
      }
      if (context.binding.conversationId === group?.conversation.id) {
        if (++groupRounds === 1) {
          await context.executeTool(
            'delegate_task',
            { botId: worker.id, goal: '写报告', expectedOutput: '文件' },
            'delegate',
          );
          return { text: '等待成员' };
        }
        return { text: '群报告已完成' };
      }
      if (++mainRounds === 1) {
        group = (await context.executeTool(
          'create_task_group',
          { name: '报告', goal: '写报告', memberIds: [worker.id] },
          'group',
        )) as typeof group;
        return { text: '等待群成果' };
      }
      const read = (await context.executeTool(
        'read_artifact',
        { artifactId },
        'read-returned',
      )) as { content: string };
      expect(read.content).toContain('真实群成果');
      return { text: '成果已经核查' };
    });
    worker = bot('作者', ['write_artifact']);
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const sent = core.tasks.send({
      conversationId: core.state.settings().mainConversationId!,
      content: '合作写报告',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.snapshot().messages.some((item) => item.content === '成果已经核查')).toBe(
      true,
    );
    const { accessibleArtifacts } = await import('../src/core/tool-access.js');
    const independent = core.chief.contexts.create({ title: '独立事项' });
    const other = core.state.storage.get<Conversation>(
      'conversations',
      independent.conversationId,
    )!;
    expect(
      accessibleArtifacts(core.state, other, core.state.settings().mainBotId!).some(
        (item) => item.id === artifactId,
      ),
    ).toBe(false);
  });
});
