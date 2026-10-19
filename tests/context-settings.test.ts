import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Bot, Connection, Task } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import { migrateContextSettings } from '../src/core/context-settings.js';
import { setup, eventually, caps, resources } from './core-harness.js';
import { defaultContextWindow, managedContextBudget } from '../src/domain/context-settings.js';

describe('智能体上下文设置', () => {
  it('目录窗口优先，ChatGPT 缺省为 272k；压缩阈值决定保留空间，独立回复预留限制实际触发点', () => {
    expect(defaultContextWindow('chatgpt', { id: 'test', name: 'GPT' })).toBe(272000);
    expect(
      defaultContextWindow('chatgpt', { id: 'test', name: 'GPT', contextWindow: 128000 }),
    ).toBe(128000);
    expect(defaultContextWindow('custom', { id: 'test', name: 'API' })).toBeUndefined();
    expect(managedContextBudget(272000)).toMatchObject({
      compactionThreshold: 85,
      outputReserve: 40800,
      availableTokens: 231200,
      triggerTokens: 231200,
      effectiveCompactionThreshold: 85,
    });
    for (const threshold of [70, 90]) {
      expect(managedContextBudget(10000, threshold)).toMatchObject({
        outputReserve: (10000 * (100 - threshold)) / 100,
        availableTokens: (10000 * threshold) / 100,
        triggerTokens: (10000 * threshold) / 100,
        effectiveCompactionThreshold: threshold,
      });
    }
    expect(managedContextBudget(10000, 90, 3000)).toMatchObject({
      compactionThreshold: 90,
      outputReserve: 3000,
      availableTokens: 7000,
      triggerTokens: 7000,
      effectiveCompactionThreshold: 70,
    });
  });

  it('ChatGPT 未提供默认窗口时，实际运行采用 272k 和 85% 阈值并保持最大能力未知', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-ai-default-context-'));
    const core = new CoreService(root, undefined, undefined, [
      {
        kind: 'chatgpt',
        probe: async () => ({ models: [], capabilities: caps }),
        run: async () => ({ text: '完成' }),
      },
    ]);
    resources.push({ core, root });
    await core.start();
    const connection = await core.entities.saveConnection({
      name: 'ChatGPT',
      provider: 'chatgpt',
      authMode: 'oauth',
    });
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      models: [{ id: 'test', name: 'GPT' }],
    });
    const member = core.entities.saveBot({
      name: '助手',
      role: '',
      instructions: '',
      connectionId: connection.id,
      model: 'test',
    });
    const room = core.entities.createConversation({
      name: '默认窗口',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '你好' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(
      core.state.storage.events().find((event) => event.type === 'context')?.data,
    ).toMatchObject({
      contextWindow: 272000,
      outputReserve: 40800,
      availableTokens: 231200,
      compactionThreshold: 85,
      triggerTokens: 231200,
      effectiveCompactionThreshold: 85,
    });
    expect(member.contextWindow).toBeUndefined();
    expect(
      core.state.storage.get<Connection>('connections', connection.id)?.models[0].maxContextWindow,
    ).toBeUndefined();
    expect(() => core.entities.saveBot({ ...member, outputReserve: 272000 })).toThrow('回复预留');
  });

  it('将旧连接的窗口迁移到继承它的智能体，保留独立值并持久幂等', async () => {
    const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
    const inherited = bot('继承'),
      independent = bot('独立');
    const nativeConnection = {
      ...connection,
      id: 'native',
      provider: 'antigravity' as const,
      contextWindow: 90000,
    };
    core.state.storage.put('connections', {
      ...connection,
      contextWindow: 48000,
      model: 'inherited-model',
      outputReserve: 2000,
    });
    core.state.storage.put('connections', nativeConnection);
    core.state.storage.put('bots', { ...independent, contextWindow: 12000 });
    core.state.storage.put('bots', { ...inherited, model: '' });
    core.state.storage.put('bots', { ...inherited, id: 'native-bot', connectionId: 'native' });
    migrateContextSettings(core.state.storage);
    expect(core.state.storage.get<Bot>('bots', inherited.id)?.contextWindow).toBe(48000);
    expect(core.state.storage.get<Bot>('bots', independent.id)?.contextWindow).toBe(12000);
    expect(core.state.storage.get<Bot>('bots', 'native-bot')?.contextWindow).toBeUndefined();
    expect(core.state.storage.get<Bot>('bots', inherited.id)?.model).toBe('inherited-model');
    expect(core.state.storage.get<Bot>('bots', inherited.id)?.outputReserve).toBe(2000);
    expect(
      core.state.storage
        .all<Connection>('connections')
        .every((item) =>
          ['contextWindow', 'model', 'outputReserve'].every((key) => !Object.hasOwn(item, key)),
        ),
    ).toBe(true);
    const persisted = core.state.storage.all('bots');
    migrateContextSettings(core.state.storage);
    expect(core.state.storage.all('bots')).toEqual(persisted);
  });

  it.each([
    { botWindow: undefined, effective: 24000 },
    { botWindow: 12000, effective: 12000 },
  ])('预算采用智能体窗口或默认模型窗口：$effective tokens', async ({ botWindow, effective }) => {
    const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      contextWindow: 90000,
      outputReserve: 2000,
      models: [{ id: 'test', name: '测试模型', contextWindow: 24000 }],
    });
    const member = core.entities.saveBot({
      ...bot('助手'),
      contextWindow: botWindow,
      outputReserve: 2000,
      compactionThreshold: 70,
    });
    const room = core.entities.createConversation({
      name: '窗口测试',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '你好' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(
      core.state.storage.events().find((event) => event.type === 'context')?.data,
    ).toMatchObject({
      contextWindow: effective,
      outputReserve: 2000,
      availableTokens: effective - 2000,
      owner: 'app',
      source: 'app-estimated',
      compactionThreshold: 70,
    });
  });

  it('连接保存忽略上下文窗口，智能体校验实际预算', async () => {
    const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
    const saved = await core.entities.saveConnection({
      ...connection,
      contextWindow: 90000,
      outputReserve: 3000,
      model: 'legacy-default',
    });
    expect(saved).not.toHaveProperty('contextWindow');
    expect(saved).not.toHaveProperty('outputReserve');
    expect(saved).not.toHaveProperty('model');
    core.state.storage.put('connections', {
      ...saved,
      status: 'ready',
      models: [{ id: 'test', name: '测试模型', contextWindow: 24000 }],
    });
    expect(() => core.entities.saveBot({ ...bot('助手'), model: '' })).toThrow('请选择模型');
    expect(() => core.entities.saveBot({ ...bot('助手'), contextWindow: 48000 })).toThrow(
      '不能超过',
    );
    expect(() => core.entities.saveBot({ ...bot('助手'), outputReserve: 24000 })).toThrow(
      '回复预留',
    );
  });

  it('默认窗口与最大窗口分别用于预算和保存校验，允许 500k 并拒绝超出目录最大值', async () => {
    let runtimeWindow: number | undefined;
    const { core, bot, connection } = await setup(async (context) => {
      runtimeWindow = context.bot.contextWindow;
      return { text: '完成' };
    });
    core.state.storage.put('connections', {
      ...connection,
      provider: 'chatgpt',
      status: 'ready',
      models: [
        { id: 'test', name: 'GPT-6.1-Sol', contextWindow: 272000, maxContextWindow: 872000 },
      ],
    });
    const saved = core.entities.saveBot({
      ...bot('助手'),
      contextWindow: 500000,
      outputReserve: 2000,
    });
    expect(saved.contextWindow).toBe(500000);
    expect(
      core.entities.saveBot({ ...saved, contextWindow: undefined }).contextWindow,
    ).toBeUndefined();
    expect(() => core.entities.saveBot({ ...saved, contextWindow: 900000 })).toThrow('不能超过');
    core.state.storage.put('connections', {
      ...connection,
      models: [
        { id: 'test', name: 'GPT-6.1-Sol', contextWindow: 272000, maxContextWindow: 872000 },
      ],
      status: 'ready',
    });
    core.state.storage.put('bots', saved);
    const room = core.entities.createConversation({
      name: '大窗口',
      kind: 'private',
      memberIds: [saved.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '你好' });
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(runtimeWindow).toBe(500000);
    expect(
      core.state.storage.events().find((event) => event.type === 'context')?.data.contextWindow,
    ).toBe(500000);
  });

  it('按各模型的最大能力校验，ChatGPT 最大值未知时不将默认窗口当硬上限', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const models = [
      { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, maxContextWindow: 872000 },
      {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6-Terra',
        contextWindow: 272000,
        maxContextWindow: 872000,
      },
      {
        id: 'gpt-daybreak-red-latest',
        name: 'Daybreak',
        contextWindow: 372000,
        maxContextWindow: 372000,
      },
      { id: 'account-model', name: 'Account model', contextWindow: 272000 },
    ];
    core.state.storage.put('connections', {
      ...connection,
      provider: 'chatgpt',
      status: 'ready',
      models,
    });
    const input = {
      name: '助手',
      role: '',
      instructions: '',
      connectionId: connection.id,
      contextWindow: 500000,
    };
    for (const model of models) {
      if (model.maxContextWindow && model.maxContextWindow < input.contextWindow) {
        expect(() => core.entities.saveBot({ ...input, model: model.id })).toThrow('不能超过');
      } else {
        expect(core.entities.saveBot({ ...input, model: model.id }).contextWindow).toBe(500000);
      }
    }
    core.state.storage.put('connections', {
      ...connection,
      provider: 'custom',
      status: 'ready',
      models,
    });
    expect(() => core.entities.saveBot({ ...input, model: 'account-model' })).toThrow('不能超过');
  });

  it('保存较大 ChatGPT 窗口时刷新旧目录并持久保存最大能力，后续保存复用该目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-ai-context-catalog-'));
    const probe = vi.fn().mockResolvedValue({
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1-Sol',
          contextWindow: 272000,
          maxContextWindow: 872000,
          maxContextWindowSource: 'provider',
        },
      ],
      capabilities: caps,
    });
    const core = new CoreService(root, undefined, undefined, [
      { kind: 'chatgpt', probe, run: async () => ({ text: '' }) },
    ]);
    resources.push({ core, root });
    await core.start();
    const connection = await core.entities.saveConnection({
      name: 'ChatGPT',
      provider: 'chatgpt',
      authMode: 'oauth',
    });
    core.state.storage.put('connections', {
      ...connection,
      status: 'ready',
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 272000 }],
    });
    const input = {
      name: '助手',
      role: '',
      instructions: '',
      connectionId: connection.id,
      model: 'gpt-6.1-sol',
      contextWindow: 500000,
    };
    const saved = (await core.request('bots.save', { input })) as Bot;
    expect(saved.contextWindow).toBe(500000);
    expect(
      core.state.storage.get<Connection>('connections', connection.id)?.models[0],
    ).toMatchObject({
      contextWindow: 272000,
      maxContextWindow: 872000,
      maxContextWindowSource: 'provider',
    });
    await core.request('bots.save', { input: { ...saved, contextWindow: 600000 } });
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(
      core.request('bots.save', { input: { ...saved, contextWindow: 900000 } }),
    ).rejects.toThrow('不能超过');
  });

  it.each(['antigravity', 'qoder'] as const)('%s 智能体由原生运行时管理预算', async (provider) => {
    const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
    core.state.storage.put('connections', {
      ...connection,
      provider,
      status: 'ready',
      outputReserve: 50000,
      models: [{ id: 'test', name: '原生模型', contextWindow: 24000 }],
    });
    const saved = core.entities.saveBot({
      ...bot('原生成员'),
      contextWindow: 12000,
      outputReserve: 60000,
    });
    expect(saved.contextWindow).toBeUndefined();
    expect(saved.outputReserve).toBeUndefined();
  });
});
