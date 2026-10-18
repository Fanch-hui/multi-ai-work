import { describe, expect, it } from 'vitest';
import type { Bot } from '../src/domain/types.js';
import { fullToolNames, permissionGroups, permissionPreset, readOnlyToolNames } from '../src/domain/tool-permissions.js';
import { migrateBotPermissions, migrateWorkSettings } from '../src/core/work-settings.js';
import { setup } from './core-harness.js';

describe('工作设置和权限迁移', () => {
  it('连接采用新默认并发，省略配置时保留已有值，并校验最大值', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const input = { name: '并发测试', provider: 'custom', baseUrl: 'http://127.0.0.1:7777' };
    expect((await core.entities.saveConnection(input)).concurrency).toBe(5);
    expect((await core.entities.saveConnection({ ...input, id: connection.id })).concurrency).toBe(1);
    expect((await core.entities.saveConnection({ ...input, concurrency: 10 })).concurrency).toBe(10);
    for (const concurrency of [0, 11])
      await expect(core.entities.saveConnection({ ...input, concurrency })).rejects.toThrow();
  });
  it('全局默认允许六个智能体，保留已配置值并将旧最大值收敛到十五', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    expect(core.state.settings().maxActiveRuns).toBe(6);
    await core.request('settings.save', { input: { maxActiveRuns: 3 } });
    core.state.syncMainTeam();
    expect(core.state.settings().maxActiveRuns).toBe(3);
    core.state.storage.setMetadata('settings', { ...core.state.settings(), maxActiveRuns: 16 });
    expect(core.state.settings().maxActiveRuns).toBe(15);
    await core.request('settings.save', { input: { maxActiveRuns: 15 } });
    for (const maxActiveRuns of [0, 16])
      await expect(core.request('settings.save', { input: { maxActiveRuns } })).rejects.toThrow();
    expect(core.state.settings().maxActiveRuns).toBe(15);
  });
  it('旧设置迁移为不限跟进，去掉深度与工具轮数，后续用户设置保持有效', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const storage = core.state.storage;
    storage.db.prepare('DELETE FROM metadata WHERE key = ?').run('work-settings-v2');
    storage.setMetadata('settings', { ...core.state.settings(), maxActiveRuns: 8, maxCoordinationRounds: 10, maxDepth: 1, maxToolRounds: 0 });
    migrateWorkSettings(storage);
    expect(core.state.settings()).toMatchObject({ maxActiveRuns: 8, maxCoordinationRounds: 0 });
    expect(core.state.settings()).not.toHaveProperty('maxDepth');
    expect(core.state.settings()).not.toHaveProperty('maxToolRounds');
    await core.request('settings.save', { input: { maxCoordinationRounds: 25, maxToolRounds: 0 } });
    core.state.syncMainTeam();
    expect(core.state.settings().maxCoordinationRounds).toBe(25);
    await core.request('settings.save', { input: { maxCoordinationRounds: 0 } });
    await expect(core.request('settings.save', { input: { maxCoordinationRounds: -1 } })).rejects.toThrow();
  });
  it('完整权限方案仅包含本身份能力，读取方案不能执行命令或写文件', () => {
    const full = fullToolNames(false), read = readOnlyToolNames(false);
    expect(full).not.toContain('delegate_task'); expect(full).not.toContain('configure_bot');
    expect(read).not.toContain('write_file'); expect(read).not.toContain('run_command');
    expect(permissionPreset(full, 'auto', false)).toBe('full');
    expect(permissionPreset(full, 'ask', false)).toBe('custom');
    expect(permissionGroups(false).some(group => group.id === 'team')).toBe(false);
  });
  it('只读方案经 Core 保存并去重后仍正确识别', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const toolNames = readOnlyToolNames(false);
    expect(toolNames.length).toBe(new Set(toolNames).size);
    const member = core.entities.saveBot({ name: '只读成员', role: '检查', instructions: '',
      connectionId: connection.id, model: 'test', toolNames, approvalMode: 'ask' });
    expect(permissionPreset(member.toolNames, member.approvalMode ?? 'ask', false)).toBe('read');
  });
  it('新建与管家创建成员默认完整自主执行，编辑保留用户权限', async () => {
    const { core, connection } = await setup(async () => ({ text: '完成' }));
    const member = core.entities.saveBot({ name: '新成员', role: '工作', instructions: '',
      connectionId: connection.id, model: 'test' });
    const delegated = core.team.configureMember({ name: '管家创建成员', connectionId: connection.id, model: 'test' });
    for (const bot of [member, delegated]) {
      expect(permissionPreset(bot.toolNames, bot.approvalMode!, false)).toBe('full');
      expect(bot.toolConnectionIds).toEqual([]);
    }
    const limited = core.entities.saveBot({ ...member, toolNames: readOnlyToolNames(false), approvalMode: 'ask' });
    const { toolNames: _, approvalMode: __, ...fields } = limited;
    const updated = core.entities.saveBot({ ...fields, name: '改名' });
    expect(permissionPreset(updated.toolNames, updated.approvalMode!, false)).toBe('read');
    expect(core.team.configureMember({ id: limited.id, role: '新职责' })).toMatchObject({
      toolNames: limited.toolNames, approvalMode: 'ask',
    });
  });
  it('原有完整工具授权使用自主执行，自定义权限和后续审批选择保持有效', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const complete = bot('完整成员', fullToolNames(false)), limited = bot('限定成员', ['read_file']);
    const withoutMode = (value: Bot) => { const { approvalMode: _, ...rest } = value; return rest; };
    core.state.storage.put('bots', withoutMode(complete)); core.state.storage.put('bots', withoutMode(limited));
    migrateBotPermissions(core.state.storage, core.state.settings().mainBotId);
    expect(core.state.storage.get<Bot>('bots', complete.id)?.approvalMode).toBe('auto');
    expect(core.state.storage.get<Bot>('bots', limited.id)).toMatchObject({ toolNames: ['read_file'], approvalMode: 'ask' });
    core.entities.saveBot({ ...complete, approvalMode: 'ask' }); core.state.syncMainTeam();
    expect(core.state.storage.get<Bot>('bots', complete.id)?.approvalMode).toBe('ask');
  });
});
