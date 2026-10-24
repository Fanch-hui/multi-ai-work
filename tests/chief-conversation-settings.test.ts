import { afterEach, describe, expect, it } from 'vitest';
import type { Bot, Connection, Conversation, Task } from '../src/domain/types.js';
import { configureProviderFetch } from '../src/providers/network.js';
import { eventually, setup } from './core-harness.js';

afterEach(() => configureProviderFetch((input, init) => fetch(input, init)));

describe('管家统一模型与推理设置', () => {
  it('JSON 请求区分省略管家档位与显式默认，创建事项保持固定入口', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      models: [{ id: 'test', name: '测试', reasoning: ['high'] }],
    });
    const configure = (input: Record<string, unknown>) =>
      core.request('chief.configure', JSON.parse(JSON.stringify({ input }))) as Promise<Bot>;
    const initial = await configure({
      connectionId: connection.id,
      model: 'test',
      reasoning: 'high',
    });
    const existing = (await core.request('chief.conversations.create', {
      name: '原对话',
    })) as Conversation;
    expect((await configure({ name: '新名字' })).reasoning).toBe('high');
    const saved = await configure({ reasoning: '' });
    expect(saved.reasoning).toBeUndefined();
    expect(core.state.storage.get<Bot>('bots', initial.id)?.reasoning).toBeUndefined();
    const next = (await core.request('chief.conversations.create', {
      name: '新对话',
    })) as Conversation;
    expect(next.id).toBe(existing.id);
    expect(next.id).toBe(core.state.settings().mainConversationId);
    expect(
      core.chief.contexts.list().filter((context) => ['原对话', '新对话'].includes(context.title)),
    ).toHaveLength(2);
    expect((await configure({ reasoning: 'high' })).reasoning).toBe('high');
    await expect(configure({ reasoning: 'low' })).rejects.toThrow('不支持');
    expect(core.state.storage.get<Bot>('bots', initial.id)?.reasoning).toBe('high');
  });

  it.each(['custom', 'chatgpt'] as const)(
    '%s 统一设置按连接能力继承推理档位，显式默认保存到 Chief',
    async (provider) => {
      const { core, connection } = await setup(async () => ({ text: '完成' }));
      core.scheduler.pause();
      core.state.storage.put('connections', {
        ...connection,
        provider,
        status: 'ready',
        models: [{ id: 'test', name: '测试' }],
      });
      const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
      core.state.storage.put('bots', {
        ...chief,
        connectionId: connection.id,
        model: 'test',
        reasoning: 'high',
      });
      const homeId = core.state.settings().mainConversationId!;
      const inheritedLegacy = (await core.request('chief.conversations.update', {
        id: homeId,
      })) as Conversation;
      expect(inheritedLegacy.reasoning).toBe(provider === 'custom' ? 'high' : undefined);
      expect(core.state.storage.get<Bot>('bots', chief.id)?.reasoning).toBe(
        inheritedLegacy.reasoning,
      );
      core.state.storage.put('connections', {
        ...connection,
        provider,
        status: 'ready',
        models: [{ id: 'test', name: '测试', reasoning: ['high'] }],
      });
      const inherited = (await core.request('chief.conversations.update', {
        id: homeId,
        reasoning: 'high',
      })) as Conversation;
      expect(inherited.reasoning).toBe('high');
      const automatic = (await core.request('chief.conversations.update', {
        id: homeId,
        reasoning: '',
      })) as Conversation;
      expect(automatic.reasoning).toBeUndefined();
      expect(core.state.storage.get<Bot>('bots', chief.id)?.reasoning).toBeUndefined();
      await expect(
        core.request('chief.conversations.update', { id: homeId, reasoning: 'low' }),
      ).rejects.toThrow('不支持');
      await expect(
        core.request('chief.conversations.create', {
          name: '事项',
          reasoning: 'high',
        }),
      ).rejects.toThrow('统一设置');
    },
  );

  it('统一推理设置在所有事项下一轮生效，原消息与工作目录保留', async () => {
    const observed: (string | undefined)[] = [];
    const { core, connection } = await setup(async (context) => {
      observed.push(context.bot.reasoning);
      return { text: '完成' };
    });
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      models: [
        { id: 'test', name: '测试', reasoning: ['low', 'high'] },
        { id: 'alternate', name: '另一模型', reasoning: ['medium'] },
      ],
    });
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', reasoning: 'low' },
    });
    const first = core.chief.contexts.create({ title: '报告 A' });
    const second = core.chief.contexts.create({ title: '报告 B' });
    const old = core.state.storage.get<Conversation>('conversations', first.conversationId)!;
    const other = core.state.storage.get<Conversation>('conversations', second.conversationId)!;
    core.state.storage.put('conversations', { ...other, model: 'test', reasoning: 'low' });
    const updated = (await core.request('chief.conversations.update', {
      id: old.id,
      reasoning: 'high',
    })) as Conversation;
    expect(updated).toMatchObject({
      id: old.id,
      model: 'test',
      reasoning: 'high',
      workspaceId: old.workspaceId,
    });
    expect(core.state.storage.get<Bot>('bots', old.chiefId!)?.reasoning).toBe('high');
    for (const room of [old, other]) {
      const sent = core.tasks.send({ conversationId: room.id, content: '收到请回复' });
      await eventually(
        () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
      );
    }
    expect(observed).toEqual(['high', 'high']);
    const switched = (await core.request('chief.conversations.update', {
      id: old.id,
      model: 'alternate',
    })) as Conversation;
    expect(switched.reasoning).toBeUndefined();
    await expect(
      core.request('chief.conversations.update', { id: old.id, reasoning: 'high' }),
    ).rejects.toThrow('不支持');
    const selected = (await core.request('chief.conversations.update', {
      id: old.id,
      reasoning: 'medium',
    })) as Conversation;
    expect(selected.reasoning).toBe('medium');
    const automatic = (await core.request('chief.conversations.update', {
      id: old.id,
      reasoning: '',
    })) as Conversation;
    expect(automatic.reasoning).toBeUndefined();
    expect(
      core.state.storage.messages(old.id).some((message) => message.content === '收到请回复'),
    ).toBe(true);
  });

  it('拒绝对群、成员私聊、归档或仍有任务的主对话更改模型', async () => {
    const { core, connection, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const room = (await core.request('chief.conversations.create', {
      name: '主管',
    })) as Conversation;
    const member = bot('成员');
    const group = core.entities.createConversation({
      name: '群',
      kind: 'group',
      chiefId: member.id,
      memberIds: [member.id],
      workspaceId: room.workspaceId,
    });
    const privateRoom = core.entities.createConversation({
      name: '成员私聊',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: room.workspaceId,
    });
    for (const conversation of [group, privateRoom])
      await expect(
        core.request('chief.conversations.update', { id: conversation.id, model: 'test' }),
      ).rejects.toThrow('只能修改');
    const task = core.tasks.create({
      conversationId: room.id,
      botId: room.chiefId!,
      goal: '进行中的工作',
    });
    const activeSetting = (await core.request('chief.conversations.update', {
      id: room.id,
      model: 'test',
      reasoning: 'high',
    })) as Conversation;
    expect(activeSetting.reasoning).toBe('high');
    await expect(
      core.request('chief.conversations.update', { id: room.id, model: 'another-model' }),
    ).rejects.toThrow('结束或停止');
    core.tasks.update(task, { status: 'cancelled' });
    core.state.storage.put('conversations', { ...room, archived: true });
    await expect(
      core.request('chief.conversations.update', { id: room.id, model: 'test' }),
    ).rejects.toThrow('归档');
  });

  it('旧 ChatGPT 目录按完整模型 ID 补全能力并保存，不扩展账号模型或覆盖明确档位', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    core.state.storage.put('bots', { ...chief, connectionId: connection.id, model: 'fixture-sol' });
    core.state.storage.put('connections', {
      ...connection,
      provider: 'chatgpt',
      status: 'ready',
      models: [
        { id: 'fixture-sol', name: '模型' },
        { id: 'fixture-no-reasoning', name: '默认模型', reasoning: [] },
        { id: 'fixture-unknown', name: '未知模型' },
      ],
    });
    configureProviderFetch(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json',
      );
      expect(request.headers.has('authorization')).toBe(false);
      return Response.json({
        models: [
          {
            slug: 'fixture-sol',
            supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
            max_context_window: 1000000,
          },
          { slug: 'fixture-no-reasoning', supported_reasoning_levels: [{ effort: 'high' }] },
          { slug: 'fixture-extra', supported_reasoning_levels: [{ effort: 'low' }] },
        ],
      });
    });
    const catalog = (await core.request('chief.conversations.catalog')) as Connection;
    expect(catalog.models.map((model) => model.id)).toEqual([
      'fixture-sol',
      'fixture-no-reasoning',
      'fixture-unknown',
    ]);
    expect(catalog.models[0]).toMatchObject({
      reasoning: ['medium', 'high'],
      reasoningSource: 'official-catalog',
    });
    expect(catalog.models[1].reasoning).toEqual([]);
    expect(catalog.models[2].reasoning).toBeUndefined();
    expect(core.state.storage.get<Connection>('connections', connection.id)?.models).toEqual(
      catalog.models,
    );
    const configured = (await core.request('chief.configure', {
      input: { reasoning: 'high' },
    })) as Bot;
    expect(configured.reasoning).toBe('high');
    const room = (await core.request('chief.conversations.create', {
      name: '所选推理',
      reasoning: 'high',
    })) as Conversation;
    expect(room.id).toBe(core.state.settings().mainConversationId);
    expect(core.state.storage.get<Bot>('bots', chief.id)?.reasoning).toBe('high');
  });
});
