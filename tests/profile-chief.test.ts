import { describe, expect, it } from 'vitest';
import type { Bot, Snapshot } from '../src/domain/types.js';
import { chiefInstructions, chiefRole } from '../src/core/chief.js';
import { eventually, setup } from './core-harness.js';

describe('个人头像与内置主管', () => {
  it('保存内置或上传头像，仅修改个人设置并保持工作配置', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const original = core.state.settings();
    await core.request('settings.save', { input: { userAvatar: 'fox' } });
    expect(core.state.settings()).toEqual({ ...original, userAvatar: 'fox' });
    const uploaded =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSNsAAAAASUVORK5CYII=';
    await core.request('settings.save', { input: { userAvatar: uploaded } });
    await core.request('settings.save', { input: { maxActiveRuns: 4 } });
    expect(core.state.storage.metadata('settings')).toMatchObject({
      userAvatar: uploaded,
      maxActiveRuns: 4,
      mainBotId: original.mainBotId,
    });
    await expect(
      core.request('settings.save', { input: { userAvatar: 'https://example.com/avatar.png' } }),
    ).rejects.toThrow('头像格式');
    expect(core.state.settings().userAvatar).toBe(uploaded);
  });

  it('主管配置接口保持内置身份，公开快照和团队目录不提供职责与指令', async () => {
    let seenInstructions = '';
    const { core, connection, bot } = await setup(async (context) => {
      seenInstructions = context.instructions;
      return { text: '完成' };
    });
    const response = (await core.request('chief.configure', {
      input: {
        connectionId: connection.id,
        model: 'test',
        role: '可修改角色',
        instructions: '替换内置提示',
        avatar: 'owl',
      },
    })) as Bot;
    expect(response).toMatchObject({ role: '', instructions: '', avatar: 'owl' });
    const chiefId = core.state.settings().mainBotId!;
    const internal = core.state.storage.get<Bot>('bots', chiefId)!;
    expect(internal).toMatchObject({ role: chiefRole, instructions: chiefInstructions });
    const updated = (await core.request('bots.save', {
      input: { ...internal, role: '再次修改', instructions: '再次替换' },
    })) as Bot;
    expect(updated).toMatchObject({ role: '', instructions: '' });
    expect(core.state.storage.get<Bot>('bots', chiefId)?.instructions).toBe(chiefInstructions);
    expect(() => core.entities.cloneBot(chiefId)).toThrow('内置成员');
    const member = bot('普通成员');
    const snapshot = (await core.request('state.snapshot')) as Snapshot;
    expect(snapshot.bots.find((item) => item.id === chiefId)).toMatchObject({
      role: '',
      instructions: '',
    });
    expect(snapshot.bots.find((item) => item.id === member.id)?.role).toBe('普通成员');
    const catalog = core.team.catalog().bots.find((item) => item.id === chiefId)!;
    expect(catalog.role).toBeUndefined();
    expect(catalog.instructions).toBeUndefined();
    const sent = core.tasks.send({
      conversationId: core.state.settings().mainConversationId!,
      content: '处理当前目标',
    });
    await eventually(
      () =>
        core.state.snapshot().tasks.find((task) => task.id === sent.taskIds[0])?.status ===
        'completed',
    );
    expect(seenInstructions).toContain(chiefInstructions);
  });

  it('旧主管身份采用内置提示，保留名称、模型、头像与授权，重复同步不重写版本', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', name: '我的主管', avatar: 'panda' },
    });
    const chiefId = core.state.settings().mainBotId!;
    const original = core.state.storage.get<Bot>('bots', chiefId)!;
    core.state.storage.put('bots', { ...original, role: '旧职责', instructions: '旧指令' });
    core.state.syncMainTeam();
    const upgraded = core.state.storage.get<Bot>('bots', chiefId)!;
    expect(upgraded).toEqual({
      ...original,
      role: chiefRole,
      instructions: chiefInstructions,
      revision: original.revision + 1,
    });
    core.state.syncMainTeam();
    expect(core.state.storage.get<Bot>('bots', chiefId)).toEqual(upgraded);
  });
});
