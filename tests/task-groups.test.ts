import { describe, expect, it } from 'vitest';
import type { Connection, Conversation, SessionBinding, Task } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

describe('主管主对话与任务群', () => {
  it('建群固定关联当轮主管发言，重复调用和后续发言保持原锚点', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    bot('Chief');
    const room = core.state.storage.get<Conversation>(
      'conversations',
      core.state.settings().mainConversationId!,
    )!;
    const instruction = core.state.storage.appendMessage({
      id: 'group-instruction',
      conversationId: room.id,
      authorType: 'user',
      content: '请安排协作',
      artifactIds: [],
      status: 'committed',
      createdAt: new Date().toISOString(),
    });
    const source = core.tasks.create({
      conversationId: room.id,
      botId: room.chiefId!,
      goal: instruction.content,
      sourceMessageId: instruction.id,
    });
    core.state.storage.put('tasks', { ...source, runIds: ['creation-run'] });
    const reply = core.state.storage.appendMessage({
      ...instruction,
      id: 'group-creation-reply',
      authorType: 'bot',
      authorBotId: room.chiefId,
      runId: 'creation-run',
      content: '我来安排成员协作',
    });
    const input = { name: '协作群', goal: '成员协作', memberIds: [bot('成员').id] };
    const group = core.team.createTaskGroup(source, input, 'creation-run');
    expect(group.conversation.sourceMessageId).toBe(reply.id);
    core.state.storage.appendMessage({ ...reply, id: 'later-reply', content: '稍后的回复' });
    expect(core.team.createTaskGroup(source, input, 'creation-run').conversation).toEqual(
      group.conversation,
    );
    expect(
      core.state.snapshot().conversations.find((item) => item.id === group.conversation.id),
    ).toMatchObject({ sourceMessageId: reply.id });
  });

  it('后台建群沿真实来源找回用户指令，旧群快照补全关联', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    bot('Chief');
    const s = core.state.storage;
    const homeId = core.state.settings().mainConversationId!;
    const instruction = s.appendMessage({
      id: 'visible-instruction',
      conversationId: homeId,
      authorType: 'user',
      content: '请为这项工作组建团队',
      artifactIds: [],
      status: 'committed',
      createdAt: new Date().toISOString(),
    });
    const room = core.team.createChiefExecutionConversation('后台工作');
    const hidden = s.appendMessage({
      ...instruction,
      id: 'hidden-work-instruction',
      conversationId: room.id,
    });
    s.setMetadata(`chief-work-source:${hidden.id}`, { sourceMessageIds: [instruction.id] });
    const source = core.tasks.create({
      conversationId: room.id,
      botId: room.chiefId!,
      goal: '后台协作',
      sourceMessageId: hidden.id,
    });
    s.put('tasks', { ...source, runIds: ['hidden-run'] });
    s.appendMessage({
      ...hidden,
      id: 'hidden-reply',
      authorType: 'bot',
      authorBotId: room.chiefId,
      runId: 'hidden-run',
      content: '开始建群',
    });
    const group = core.team.createTaskGroup(
      source,
      { name: '后台协作群', goal: '协作', memberIds: [bot('成员').id] },
      'hidden-run',
    );
    expect(group.conversation.sourceMessageId).toBe(instruction.id);
    s.put('conversations', { ...group.conversation, sourceMessageId: undefined });
    expect(
      core.state.snapshot().conversations.find((item) => item.id === group.conversation.id),
    ).toMatchObject({ sourceMessageId: instruction.id });
  });

  it('事项保存所选工作目录，任务群继承统一管家模型而不公开系统目标', async () => {
    const { core, connection, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      models: [
        { id: 'test', name: '测试' },
        { id: 'alternate', name: '另一个模型', reasoning: ['high'] },
      ],
    });
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'alternate', reasoning: 'high' },
    });
    const workspace = await core.entities.addWorkspace({
      name: '本轮目录',
      path: core.state.dataDirectory,
      writable: true,
    });
    const room = core.team.createChiefConversation('本轮讨论', {
      workspaceId: workspace.id,
      model: 'alternate',
      reasoning: 'high',
    });
    expect(room).toMatchObject({
      workspaceId: workspace.id,
      model: 'alternate',
      reasoning: 'high',
    });
    const source = core.tasks.create({
      conversationId: room.id,
      botId: room.chiefId!,
      goal: '需要协作',
    });
    const group = core.team.createTaskGroup(source, {
      name: '协作',
      goal: '仅供成员理解的工作目标',
      memberIds: [bot('成员').id],
    });
    expect(group.conversation).toMatchObject({
      model: 'alternate',
      reasoning: 'high',
      workspaceId: workspace.id,
    });
    expect(core.state.storage.messages(group.conversation.id)).toEqual([]);
    expect(group.task.goal).toBe('仅供成员理解的工作目标');
    expect(() => core.team.createChiefConversation('无效模型', { model: 'missing' })).toThrow(
      '不提供',
    );
    expect(() =>
      core.team.createChiefConversation('无效档位', { model: 'alternate', reasoning: 'low' }),
    ).toThrow('不支持');
  });

  it('群任务先于来源主管本轮完成时仍唤醒主管汇总', async () => {
    let groupId = '',
      selectedId = '',
      rounds = 0;
    const { core, connection, bot } = await setup(async (context) => {
      if (context.binding.conversationId !== core.state.settings().mainConversationId)
        return { text: '快速群成果' };
      if (++rounds === 1) {
        const group = (await context.executeTool(
          'create_task_group',
          { name: '快速群', goal: '快速任务', memberIds: [selectedId] },
          'group',
        )) as { task: Task };
        groupId = group.task.id;
        await eventually(
          () => core.state.storage.get<Task>('tasks', groupId)?.status === 'completed',
        );
        return { text: '建群成功' };
      }
      expect(context.prompt).toContain('快速群成果');
      return { text: '确认快速成果' };
    });
    selectedId = bot('相关成员').id;
    core.state.storage.put('connections', {
      ...core.state.storage.get<Connection>('connections', connection.id)!,
      concurrency: 2,
    });
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const sent = core.tasks.send({
      conversationId: core.state.settings().mainConversationId!,
      content: '快速工作',
    });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(rounds).toBe(2);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.result).toBe('确认快速成果');
  });

  it('按相关成员创建持久任务群，只共享显式任务，群成果唤醒来源主管', async () => {
    let selectedId = '',
      group: { conversation: Conversation; task: Task } | undefined;
    let mainRounds = 0,
      groupRounds = 0;
    const { core, connection, bot } = await setup(async (context) => {
      if (context.bot.id === selectedId) {
        expect(context.prompt).not.toContain('主对话隐私');
        await context.executeTool('post_message', { content: '成员讨论意见' }, 'discussion');
        return { text: '成员核查成果' };
      }
      if (context.binding.conversationId === group?.conversation.id) {
        expect(context.prompt).not.toContain('主对话隐私');
        expect(context.tools.some((tool) => tool.name === 'create_task_group')).toBe(false);
        if (++groupRounds === 1) {
          await context.executeTool(
            'delegate_task',
            { botId: selectedId, goal: '核查任务', expectedOutput: '结论' },
            'delegate',
          );
          return { text: '请成员核查' };
        }
        expect(context.prompt).toContain('成员核查成果');
        return { text: '群协作结论' };
      }
      if (++mainRounds === 1) {
        expect(context.tools.some((tool) => tool.name === 'delegate_task')).toBe(false);
        const args = {
          name: '专项任务',
          goal: '公开任务目标',
          memberIds: [selectedId],
          expectedOutput: '结论',
        };
        group = (await context.executeTool('create_task_group', args, 'group')) as typeof group;
        const replay = (await context.executeTool(
          'create_task_group',
          args,
          'group-replayed',
        )) as typeof group;
        expect(replay!.conversation.id).toBe(group!.conversation.id);
        return { text: '已建立专项群' };
      }
      expect(context.prompt).toContain('群协作结论');
      const state = (await context.executeTool(
        'get_task',
        { taskId: group!.task.id },
        'group-status',
      )) as Task;
      expect(state.status).toBe('completed');
      return { text: '主对话最终汇总' };
    });
    selectedId = bot('相关成员', ['post_message']).id;
    const unrelated = bot('无关成员');
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const mainId = core.state.settings().mainConversationId!;
    const sent = core.tasks.send({ conversationId: mainId, content: '主对话隐私，请完成工作' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(group!.conversation).toMatchObject({
      kind: 'group',
      purpose: 'task',
      sourceConversationId: mainId,
      sourceTaskId: sent.taskIds[0],
    });
    expect(group!.conversation.memberIds).toEqual([core.state.settings().mainBotId, selectedId]);
    expect(group!.conversation.memberIds).not.toContain(unrelated.id);
    expect(
      core.state.storage
        .all<Conversation>('conversations')
        .filter((room) => room.purpose === 'task'),
    ).toHaveLength(1);
    expect(
      core.state.storage
        .messages(group!.conversation.id)
        .some((message) => message.content === '成员讨论意见'),
    ).toBe(true);
    expect(
      core.state.storage.messages(mainId).some((message) => message.content === '主对话最终汇总'),
    ).toBe(true);
    expect(mainRounds).toBe(2);
    expect(groupRounds).toBe(2);
    const contribution = core.tasks.send({
      conversationId: group!.conversation.id,
      content: '用户补充要求',
    });
    expect(core.state.storage.get<Task>('tasks', contribution.taskIds[0])?.botId).toBe(
      core.state.settings().mainBotId,
    );
    expect(core.state.storage.messages(group!.conversation.id).at(-1)?.authorType).toBe('user');
  });

  it('固定主入口保留旧历史，工作项使用独立绑定，迁移保留旧团队群', async () => {
    const { core, root, connection, bot } = await setup(async () => ({ text: '主管回复' }));
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const oldId = core.state.settings().mainConversationId!;
    const first = core.tasks.send({ conversationId: oldId, content: '旧主对话' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', first.taskIds[0])?.status === 'completed',
    );
    const next = (await core.request('chief.conversations.create', {
      name: '新主对话',
    })) as Conversation;
    expect(next.id).toBe(oldId);
    const context = core.chief.contexts
      .list()
      .find((item) => item.id === core.chief.contexts.focus().contextId)!;
    const second = (await core.request('chief.inputs.send', {
      targetContextId: context.id,
      content: '新事项',
    })) as { taskIds: string[] };
    await eventually(
      () => core.state.storage.get<Task>('tasks', second.taskIds[0])?.status === 'completed',
    );
    expect(
      core.state.storage
        .all<SessionBinding>('session_bindings')
        .map((binding) => binding.conversationId),
    ).toEqual([oldId, core.chief.contexts.main().room.id]);
    expect(
      core.state.storage
        .messages(core.chief.contexts.main().room.id)
        .some((message) => message.content === '旧主对话'),
    ).toBe(false);
    const member = bot('历史成员');
    const legacy = core.entities.createConversation({
      name: '旧团队群',
      kind: 'group',
      chiefId: core.state.settings().mainBotId,
      memberIds: [core.state.settings().mainBotId, member.id],
      workspaceId: next.workspaceId,
    });
    core.tasks.post(legacy.id, member.id, 'historic', '旧群历史');
    core.state.storage.setMetadata('settings', {
      ...core.state.settings(),
      mainConversationId: legacy.id,
    });
    const reopened = new State(root);
    expect(reopened.storage.get('conversations', legacy.id)).toEqual(legacy);
    expect(reopened.storage.messages(legacy.id)[0].content).toBe('旧群历史');
    const migrated = reopened.storage.get<Conversation>(
      'conversations',
      reopened.settings().mainConversationId!,
    )!;
    expect(migrated).toMatchObject({
      kind: 'private',
      purpose: 'chief',
      memberIds: [reopened.settings().mainBotId],
    });
    reopened.storage.close();
  });

  it('只允许关联主任务启动群主管任务，拒绝其他跨对话委派与私聊读取', async () => {
    const { core, connection, bot } = await setup(async (context) => {
      if (context.bot.id === member.id) {
        const denied = (await context.executeTool(
          'get_task',
          { taskId: source.id },
          'private-task',
        )) as { error: string };
        expect(denied.error).toContain('未授权');
      }
      return { text: '完成' };
    });
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const member = bot('成员', ['get_task']);
    const source = core.tasks.create({
      conversationId: core.state.settings().mainConversationId!,
      botId: core.state.settings().mainBotId!,
      goal: '主任务',
    });
    const group = core.team.createTaskGroup(source, {
      name: '群',
      goal: '显式任务',
      memberIds: [member.id],
    });
    expect(() =>
      core.tasks.create({
        conversationId: group.conversation.id,
        botId: member.id,
        parentId: source.id,
        goal: '越权跨会话',
      }),
    ).toThrow('不允许继续委派');
    const privateRoom = core.entities.createConversation({
      name: '成员私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: group.conversation.workspaceId,
    });
    const memberTask = core.tasks.create({
      conversationId: privateRoom.id,
      botId: member.id,
      goal: '成员任务',
    });
    expect(() =>
      core.team.createTaskGroup(memberTask, {
        name: '越权群',
        goal: '目标',
        memberIds: [member.id],
      }),
    ).toThrow('只有主对话的主管');
    expect(() =>
      core.team.createTaskGroup(group.task, {
        name: '嵌套群',
        goal: '目标',
        memberIds: [member.id],
      }),
    ).toThrow('只有主对话的主管');
    const visibleTask = core.tasks.create({
      conversationId: group.conversation.id,
      botId: member.id,
      goal: '查任务',
    });
    core.tasks.update(source, { status: 'cancelled' });
    core.tasks.update(group.task, { status: 'cancelled' });
    core.tasks.update(memberTask, { status: 'cancelled' });
    core.scheduler.resume();
    await eventually(
      () => core.state.storage.get<Task>('tasks', visibleTask.id)?.status === 'completed',
    );
  });
});
