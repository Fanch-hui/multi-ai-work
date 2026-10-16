import { describe, expect, it } from 'vitest';
import { setup } from './core-harness.js';

describe('Core update admission', () => {
  it('blocks unfinished work, then prevents new requests and internal tasks until released', async () => {
    const { core, bot } = await setup(async () => ({ text: 'done' }));
    core.scheduler.pause();
    const chief = bot('Chief');
    const conversationId = core.state.settings().mainConversationId!;
    const task = core.tasks.create({ conversationId, botId: chief.id, goal: 'finish work' });
    await expect(core.request('system.prepareUpdate')).rejects.toThrow('所有任务');
    core.tasks.update(task, { status: 'waiting_input' });
    await expect(core.request('system.prepareUpdate')).rejects.toThrow('所有任务');
    core.tasks.update(task, { status: 'completed' });
    expect(await core.request('system.prepareUpdate')).toEqual({ ready: true });
    await expect(core.request('state.snapshot')).resolves.toHaveProperty('settings');
    await expect(core.request('conversations.send', { conversationId, content: 'new' })).rejects.toThrow('安装更新');
    expect(() => core.tasks.create({ conversationId, botId: chief.id, goal: 'internal work' })).toThrow();
    await core.request('system.releaseUpdate');
    await expect(core.request('conversations.send', { conversationId, content: 'new' })).resolves.toHaveProperty('messageId');
  });

  it('does not acquire admission while an earlier asynchronous import is pending', async () => {
    let finish!: (value: unknown) => void;
    const { core } = await setup(async () => ({ text: 'done' }), async () => new Promise(resolve => { finish = resolve; }));
    const importing = core.request('conversations.attach', { conversationId: core.state.settings().mainConversationId });
    await expect(core.request('system.prepareUpdate')).rejects.toThrow('操作正在处理');
    finish({ paths: [] });
    expect(await importing).toEqual({ cancelled: true });
    expect(await core.request('system.prepareUpdate')).toEqual({ ready: true });
    await core.request('system.releaseUpdate');
  });
});
