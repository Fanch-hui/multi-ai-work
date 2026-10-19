import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, Task } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

describe('主智能体与团队管理', () => {
  it('保留独立主入口、用户模型配置与原有私聊', async () => {
    const { core, root, connection, bot } = await setup(async () => ({ text: '完成' }));
    const initial = core.state.snapshot();
    const chief = initial.bots.find((item) => item.id === initial.settings.mainBotId)!;
    expect(chief.connectionId).toBe('');
    const member = bot('研究员');
    const privateRoom = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: initial.workspaces[0].id,
    });
    core.tasks.post(privateRoom.id, member.id, 'prior-run', '私聊资料');
    const saved = (await core.request('chief.configure', {
      input: {
        connectionId: connection.id,
        model: 'test',
        contextWindow: 20000,
        outputReserve: 1000,
      },
      workspaceId: initial.workspaces[0].id,
    })) as Bot;
    expect(saved.id).toBe(chief.id);
    expect(saved.contextWindow).toBe(20000);
    const main = core.state.storage.get<Conversation>(
      'conversations',
      initial.settings.mainConversationId!,
    )!;
    expect(main.chiefId).toBe(chief.id);
    expect(main).toMatchObject({ kind: 'private', purpose: 'chief' });
    expect(main.memberIds).toEqual([chief.id]);
    expect(chief.toolNames).toEqual(
      expect.arrayContaining(['read_file', 'write_file', 'run_command', 'ask_user']),
    );
    expect(core.state.storage.messages(main.id)).toEqual([]);
    expect(core.state.storage.messages(privateRoom.id)[0].content).toBe('私聊资料');
    await expect(core.request('bots.archive', { id: chief.id })).rejects.toThrow(
      '主智能体需要保留',
    );
    const reopened = new State(root);
    expect(reopened.settings().mainBotId).toBe(chief.id);
    expect(reopened.snapshot().bots.filter((item) => item.id === chief.id)).toHaveLength(1);
    reopened.storage.close();
  });

  it('主智能体经批准创建成员，立即派发任务并汇总', async () => {
    let rounds = 0;
    let child: Task | undefined;
    const { core, connection } = await setup(async (context) => {
      if (context.bot.id !== core.state.settings().mainBotId) return { text: '研究成果' };
      if (context.binding.conversationId !== core.state.settings().mainConversationId) {
        if (!child) {
          const room = core.state.storage.get<Conversation>(
            'conversations',
            context.binding.conversationId,
          )!;
          child = (await context.executeTool(
            'delegate_task',
            { botId: room.memberIds[1], goal: '调研', expectedOutput: '说明' },
            'delegate',
          )) as Task;
          return { text: '已安排' };
        }
        expect(context.prompt).toContain('研究成果');
        return { text: '任务群汇总' };
      }
      if (++rounds === 1) {
        const catalog = (await context.executeTool('list_bots', {}, 'catalog')) as {
          connections: { id: string }[];
        };
        expect(catalog.connections[0].id).toBe(connection.id);
        const member = (await context.executeTool(
          'configure_bot',
          { name: '研究员', role: '调研', connectionId: connection.id, model: 'test' },
          'configure',
        )) as Bot;
        await context.executeTool(
          'create_task_group',
          { name: '调研', goal: '调研', memberIds: [member.id] },
          'create-group',
        );
        return { text: '已创建调研群' };
      }
      expect(context.prompt).toContain('任务群汇总');
      return { text: '汇总完成' };
    });
    const chief = core.state
      .snapshot()
      .bots.find((bot) => bot.id === core.state.settings().mainBotId)!;
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', approvalMode: 'ask' },
    });
    const sent = (await core.request('conversations.send', {
      conversationId: core.state.settings().mainConversationId,
      content: '请创建研究员并安排调研',
      requestId: 'chief-work',
    })) as { taskIds: string[] };
    await eventually(() =>
      core.state.snapshot().approvals.some((item) => item.status === 'pending'),
    );
    const approval = core.state.snapshot().approvals.find((item) => item.status === 'pending')!;
    expect(approval.botId).toBe(chief.id);
    expect(approval.toolName).toBe('configure_bot');
    await core.request('approvals.resolve', { id: approval.id, approved: true });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(rounds).toBe(2);
    const groupTask = core.state.storage
      .all<Task>('tasks')
      .find((task) => task.parentId === sent.taskIds[0])!;
    expect(child?.parentId).toBe(groupTask.id);
    expect(core.state.storage.get<Task>('tasks', child!.id)?.result).toBe('研究成果');
    expect(core.state.storage.all<Task>('tasks')).toHaveLength(3);
  });

  it('普通成员即使填写工具名也不能修改团队配置', async () => {
    const { core, bot } = await setup(async (context) => {
      expect(
        context.tools.some((tool) =>
          ['configure_bot', 'list_bots', 'create_task_group'].includes(tool.name),
        ),
      ).toBe(false);
      await expect(
        context.executeTool('configure_bot', { name: '越权成员' }, 'invalid'),
      ).rejects.toThrow('未授权工具');
      await expect(
        context.executeTool(
          'create_task_group',
          { name: '越权群', goal: '测试', memberIds: [] },
          'group',
        ),
      ).rejects.toThrow('未授权工具');
      return { text: '完成' };
    });
    const member = bot('成员', ['configure_bot', 'list_bots', 'create_task_group']);
    const room = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '测试' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(core.state.snapshot().bots.some((bot) => bot.name === '越权成员')).toBe(false);
    expect(core.state.snapshot().approvals).toHaveLength(0);
  });

  it('成员权限由用户控制，强度校验目录，预算使用每 Bot 覆写', async () => {
    const { core, connection } = await setup(async () => ({
      text: '完成',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 20,
        source: 'reported' as const,
      },
    }));
    const chief = core.state
      .snapshot()
      .bots.find((bot) => bot.id === core.state.settings().mainBotId)!;
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      contextWindow: 50000,
      outputReserve: 4000,
      models: [{ id: 'test', name: '测试模型', reasoning: ['low', 'high'] }],
    });
    expect(() =>
      core.team.configureMember({
        name: '成员',
        connectionId: connection.id,
        toolNames: ['run_command'],
      }),
    ).toThrow();
    expect(() =>
      core.entities.saveBot({
        ...chief,
        connectionId: connection.id,
        model: 'test',
        reasoning: 'invalid',
      }),
    ).toThrow('不支持');
    await core.request('chief.configure', {
      input: {
        connectionId: connection.id,
        model: 'test',
        reasoning: 'high',
        contextWindow: 20000,
        outputReserve: 1000,
      },
    });
    const sent = core.tasks.send({
      conversationId: core.state.settings().mainConversationId!,
      content: '你好',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    const contextEvent = core.state.snapshot().events.find((event) => event.type === 'context')!;
    expect(contextEvent.data).toMatchObject({
      contextWindow: 20000,
      outputReserve: 1000,
      availableTokens: 19000,
    });
    const run = core.state.snapshot().runs[0];
    expect(run.usage?.cachedInputTokens).toBe(20);
    expect(run.inferenceUsage?.outputTokens).toBe(10);
    expect(run.inferenceDurationMs).toBeGreaterThanOrEqual(0);
  });
});
