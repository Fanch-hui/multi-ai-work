import { describe, expect, it } from 'vitest';
import type { Bot, Conversation, Settings } from '../src/domain/types.js';
import { State } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

describe('管家首次设置', () => {
  it('首次进入引导，稍后设置在重启后仍有效，不创建欢迎消息或任务', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    expect(core.state.settings().onboardingStatus).toBe('pending');
    await core.request('onboarding.skip');
    const reopened = new State(root);
    try {
      expect(reopened.settings().onboardingStatus).toBe('skipped');
      expect(reopened.snapshot().messages).toHaveLength(0);
      expect(reopened.snapshot().tasks).toHaveLength(0);
    } finally {
      reopened.storage.close();
    }
  });

  it('配置、欢迎消息与完成状态一起持久化，重试不重复，后续真实任务承接欢迎对话', async () => {
    let prompt = '';
    const { core, root, connection } = await setup(async (context) => {
      prompt = context.prompt;
      return { text: '开始整理' };
    });
    await core.request('onboarding.skip');
    const input = {
      name: '小管家',
      connectionId: connection.id,
      model: 'test',
      workspaceId: core.state.snapshot().workspaces[0].id,
      contextWindow: 272000,
      compactionThreshold: 85,
    };
    const initialId = core.state.settings().mainConversationId;
    const room = (await core.request('onboarding.complete', { input })) as Conversation;
    expect(room).toMatchObject({ id: initialId, name: '小管家', model: 'test', purpose: 'chief' });
    expect(core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)).toMatchObject({
      contextWindow: 272000,
      compactionThreshold: 85,
    });
    expect(await core.request('onboarding.complete', { input })).toEqual(room);
    const messages = core.state.storage.messages(room.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorType: 'bot',
      authorBotId: core.state.settings().mainBotId,
      status: 'committed',
    });
    expect(messages[0].content).toContain('专属 AI 管家');
    expect(core.state.snapshot().tasks).toHaveLength(0);
    const reopened = new State(root);
    try {
      expect(reopened.settings().onboardingStatus).toBe('completed');
      expect(reopened.storage.messages(room.id)).toEqual(messages);
    } finally {
      reopened.storage.close();
    }
    const sent = core.tasks.send({ conversationId: room.id, content: '帮我整理资料' });
    await eventually(
      () =>
        core.state.snapshot().tasks.find((task) => task.id === sent.taskIds[0])?.status ===
        'completed',
    );
    expect(prompt).toContain('帮我整理资料');
  });

  it('无效配置不修改管家、会话或引导状态', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const before = core.state.snapshot();
    await expect(
      core.request('onboarding.complete', {
        input: { name: '管家', connectionId: connection.id, model: 'test', workspaceId: 'missing' },
      }),
    ).rejects.toThrow('工作目录不存在');
    const after = core.state.snapshot();
    expect(after.bots).toEqual(before.bots);
    expect(after.conversations).toEqual(before.conversations);
    expect(after.settings.onboardingStatus).toBe('pending');
    expect(after.messages).toHaveLength(0);
  });

  it('升级时识别已有配置，不向已有对话插入欢迎消息', async () => {
    const { core, root, connection } = await setup(async () => ({ text: '完成' }));
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test' },
    });
    const { onboardingStatus: _, ...legacy } = core.state.settings();
    core.state.storage.setMetadata('settings', legacy);
    const reopened = new State(root);
    try {
      expect(reopened.settings().onboardingStatus).toBe('completed');
      expect(reopened.snapshot().messages).toHaveLength(0);
    } finally {
      reopened.storage.close();
    }
  });

  it.each(['antigravity', 'qoder'] as const)('管家拒绝 %s，普通成员仍可使用', async (provider) => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const native = { ...connection, id: provider, provider, status: 'ready' as const };
    core.state.storage.put('connections', native);
    const input = { connectionId: native.id, model: 'native-model' };
    await expect(core.request('chief.configure', { input })).rejects.toThrow(
      'ChatGPT 或自定义 API',
    );
    const chief = core.state.storage.get<Bot>('bots', core.state.settings().mainBotId!)!;
    expect(() => core.entities.saveBot({ ...chief, ...input })).toThrow('ChatGPT 或自定义 API');
    const member = core.entities.saveBot({
      ...input,
      name: '成员',
      role: '研究员',
      instructions: '',
    });
    expect(member.connectionId).toBe(native.id);
    core.state.storage.put('bots', { ...chief, ...input });
    const { onboardingStatus: _, ...legacy } = core.state.settings() as Settings;
    core.state.storage.setMetadata('settings', legacy);
    core.state.syncMainTeam();
    expect(core.state.settings().onboardingStatus).toBe('pending');
    expect(() =>
      core.tasks.create({
        conversationId: core.state.settings().mainConversationId!,
        botId: chief.id,
        goal: '测试',
      }),
    ).toThrow('ChatGPT 或自定义 API');
  });
});
