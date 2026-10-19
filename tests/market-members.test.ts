import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentPreset, PresetInstallation, PresetMemberResult } from '../src/domain/market.js';
import type { Bot, Skill, Task } from '../src/domain/types.js';
import { fixtureEntries, fixturePreset, zipFixture } from './preset-package-fixture.js';
import { setup, eventually } from './core-harness.js';
import { sessionBinding } from '../src/core/session-binding.js';
import { authorizedSkills, importSkillPackage } from '../src/core/skills.js';

async function prepare(preset = fixturePreset()) {
  const setupResult = await setup(async () => ({ text: 'done' }));
  setupResult.core.scheduler.pause();
  const path = join(setupResult.root, 'preset.zip');
  await writeFile(path, zipFixture(fixtureEntries(preset)));
  const installed = (await setupResult.core.request('market.import', {
    path,
  })) as PresetInstallation;
  const configuration = {
    connectionId: setupResult.connection.id,
    model: 'test',
    toolNames: ['read_skill'],
    approvalMode: 'ask',
    toolConnectionIds: [],
    personalInstructions: '以中文回答',
  };
  const add = async (requestId = 'create-one') => {
    const results = (await setupResult.core.request('market.members.create', {
      items: [{ requestId, installationId: installed.id, configuration }],
    })) as PresetMemberResult[];
    return setupResult.core.state.storage.get<Bot>('bots', results[0]!.botId!)!;
  };
  return { ...setupResult, installed, configuration, path, add };
}

describe('preset members', () => {
  it('persists the complete hiring configuration and combines only authorized extra skills', async () => {
    const { core, root, installed, configuration } = await prepare();
    const source = join(root, 'hiring-skill');
    await mkdir(source);
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: extra\ndescription: 额外技能\n---\n保留原始出处。',
    );
    const extra = await importSkillPackage(core.state, join(source, 'SKILL.md'));
    const [result] = (await core.request('market.members.create', {
      items: [
        {
          requestId: 'full-config',
          installationId: installed.id,
          configuration: {
            ...configuration,
            name: '我的助手',
            role: '定制职责',
            avatar: 'owl',
            color: '#047857',
            contextWindow: 64000,
            compactionThreshold: 70,
            memoryMode: 'off',
            skillIds: [extra.id],
            approvalMode: 'auto',
          },
        },
      ],
    })) as PresetMemberResult[];
    expect(result?.error).toBeUndefined();
    const member = core.state.storage.get<Bot>('bots', result!.botId!)!;
    expect(member).toMatchObject({
      name: '我的助手',
      role: '定制职责',
      avatar: 'owl',
      color: '#047857',
      contextWindow: 64000,
      compactionThreshold: 70,
      memoryMode: 'off',
      approvalMode: 'auto',
      personalInstructions: '以中文回答',
    });
    expect(member.skillIds).toEqual([...installed.skillIds, extra.id]);
    expect(member.preset?.managedSkillIds).toEqual(installed.skillIds);
    expect(member.instructions).toContain(installed.preset.instructions);
    expect(member.instructions).toContain('以中文回答');

    for (const fields of [
      { contextWindow: 512 },
      { compactionThreshold: 96 },
      { skillIds: ['missing-skill'] },
    ]) {
      const [invalid] = (await core.request('market.members.create', {
        items: [
          {
            requestId: JSON.stringify(fields),
            installationId: installed.id,
            configuration: { ...configuration, ...fields },
          },
        ],
      })) as PresetMemberResult[];
      expect(invalid?.error).toBeTruthy();
      expect(invalid?.botId).toBeUndefined();
    }
  });

  it('keeps preset skills with bound members and permits separately imported shared skills', async () => {
    const { core, root, installed, add, bot } = await prepare();
    const skillId = installed.skillIds[0]!;
    expect(core.state.storage.get<Skill>('skills', skillId)?.presetOnly).toBeUndefined();
    expect(core.state.snapshot().skills.find((skill) => skill.id === skillId)?.presetOnly).toBe(
      true,
    );

    const member = await add(),
      other = bot('其他成员', ['read_skill']);
    expect(authorizedSkills(core.state, member).map((skill) => skill.id)).toContain(skillId);
    expect(authorizedSkills(core.state, other).map((skill) => skill.id)).not.toContain(skillId);
    await expect(
      core.request('bots.save', { input: { ...other, skillIds: [skillId] } }),
    ).rejects.toThrow('市场配套技能仅供绑定成员使用');
    await expect(
      core.request('bots.save', { input: { ...other, id: undefined, skillIds: [skillId] } }),
    ).rejects.toThrow('市场配套技能仅供绑定成员使用');

    const source = join(root, 'shared-skill');
    await mkdir(source);
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: shared\ndescription: 共享技能\n---\n通用工作规范。',
    );
    const shared = await importSkillPackage(core.state, join(source, 'SKILL.md'));
    const configured = (await core.request('bots.save', {
      input: { ...other, skillIds: [shared.id] },
    })) as Bot;
    expect(
      core.state.snapshot().skills.find((skill) => skill.id === shared.id)?.presetOnly,
    ).toBeUndefined();
    expect(authorizedSkills(core.state, configured).map((skill) => skill.id)).toContain(shared.id);
    expect(authorizedSkills(core.state, configured).map((skill) => skill.id)).not.toContain(
      skillId,
    );

    const clone = core.entities.cloneBot(member.id);
    expect(clone.skillIds).toEqual(member.skillIds);
    await core.request('market.detach', { botId: member.id });
    const custom = core.state.storage.get<Bot>('bots', member.id)!;
    expect(core.entities.saveBot({ ...custom, name: '自定义成员' }).skillIds).toContain(skillId);
  });

  it('keeps downloads separate, creates independent members and retries without duplication', async () => {
    const { core, installed, configuration, add } = await prepare();
    expect(core.state.snapshot().bots.filter((bot) => bot.preset)).toHaveLength(0);
    const first = await add(),
      again = await add(),
      second = await add('create-two');
    expect(again.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.skillIds).toEqual(first.skillIds);
    core.entities.saveBot({ ...first, name: '我的助理', personalInstructions: '保留引文' });
    const configured = core.team.configureMember({
      id: first.id,
      personalInstructions: '按团队要求保留引文',
    });
    expect(configured.instructions).toContain('按团队要求保留引文');
    expect(configured.preset?.baseInstructions).toBe(installed.preset.instructions);
    expect(core.state.storage.get<Bot>('bots', second.id)?.personalInstructions).toBe('以中文回答');
    const results = (await core.request('market.members.create', {
      items: [
        {
          requestId: 'invalid-model',
          installationId: installed.id,
          configuration: { ...configuration, connectionId: 'missing' },
        },
        { requestId: 'create-two', installationId: installed.id, configuration },
      ],
    })) as PresetMemberResult[];
    expect(results[0]?.error).toContain('模型连接');
    expect(results[1]?.botId).toBe(second.id);
    expect(core.state.snapshot().bots.filter((bot) => bot.preset)).toHaveLength(2);
  });

  it('preserves user settings and extras on update, blocks unfinished tasks and permits conversion', async () => {
    const { core, path, add, installed } = await prepare(),
      member = await add();
    const s = core.state.storage;
    const extra = { ...s.get<Skill>('skills', member.skillIds[0]!)!, id: 'extra' };
    s.put('skills', extra);
    core.entities.saveBot({
      ...member,
      name: '定制姓名',
      skillIds: [...member.skillIds, extra.id],
      personalInstructions: '标记不确定事项',
    });
    const updatedPreset = fixturePreset({
      version: '2.0.0',
      instructions: '新的工作流程',
      role: '新职责',
    });
    await writeFile(path, zipFixture(fixtureEntries(updatedPreset)));
    const installed2 = (await core.request('market.import', { path })) as PresetInstallation;
    const room = core.entities.createConversation({
      name: '工作',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0]!.id,
    });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '等待回答' });
    s.put('tasks', { ...task, status: 'waiting_input' });
    const blocked = (await core.request('market.update', {
      installationId: installed2.id,
      botIds: [member.id],
    })) as { error?: string }[];
    expect(blocked[0]?.error).toContain('未结束');
    expect(s.get<Bot>('bots', member.id)?.preset?.version).toBe('1.0.0');
    s.put('tasks', { ...task, status: 'completed' });
    await core.request('market.update', { installationId: installed2.id, botIds: [member.id] });
    const updated = s.get<Bot>('bots', member.id)!;
    expect(updated).toMatchObject({
      name: '定制姓名',
      model: member.model,
      personalInstructions: '标记不确定事项',
      role: '新职责',
    });
    expect(updated.instructions).toContain('新的工作流程');
    expect(updated.instructions).toContain('标记不确定事项');
    expect(updated.skillIds).toContain(extra.id);
    expect(() => core.entities.saveBot({ ...updated, instructions: '覆盖工作流程' })).toThrow(
      '个人补充',
    );
    await core.request('market.remove', { id: installed.id });
    await expect(core.request('market.remove', { id: installed2.id })).rejects.toThrow(
      '仍被成员引用',
    );
    await core.request('market.detach', { botId: member.id });
    const custom = s.get<Bot>('bots', member.id)!;
    expect(custom.preset).toBeUndefined();
    expect(custom.instructions).toBe(updated.instructions);
    expect(core.entities.saveBot({ ...custom, instructions: '自定义工作指令' }).instructions).toBe(
      '自定义工作指令',
    );
  });

  it('requires necessary capabilities and existing skills without widening grants', async () => {
    const preset: AgentPreset = fixturePreset({
      dependencies: [{ kind: 'tool', key: 'run_command', label: '命令执行', required: true }],
    });
    const { core, installed, configuration } = await prepare(preset);
    const result = (await core.request('market.members.create', {
      items: [{ requestId: 'one', installationId: installed.id, configuration }],
    })) as PresetMemberResult[];
    expect(result[0]?.error).toContain('命令执行');
    expect(core.state.snapshot().bots.filter((bot) => bot.preset)).toHaveLength(0);
    expect(() =>
      core.entities.saveBot({
        name: 'bad',
        role: '',
        instructions: '',
        ...configuration,
        skillIds: ['nonexistent'],
      }),
    ).toThrow('技能不存在');
  });

  it('uses actual authorized read_skill resources through Core and retains a durable artifact', async () => {
    let skillId = '';
    const { core, root, connection } = await setup(async (context) => {
      expect(context.instructions).toContain('保留原始出处');
      const entry = (await context.executeTool('read_skill', { skillId }, 'entry')) as {
        content: string;
      };
      expect(entry.content).toContain('references/check.md');
      const reference = (await context.executeTool(
        'read_skill',
        { skillId, resource: 'references/check.md' },
        'reference',
      )) as { content: string };
      expect(reference.content).toContain('原文');
      const artifact = await context.executeTool(
        'write_artifact',
        { path: '材料清单.md', format: 'markdown', content: reference.content },
        'artifact',
      );
      expect(artifact).not.toHaveProperty('error');
      return { text: '已生成材料清单' };
    });
    const path = join(root, 'preset.zip');
    await writeFile(path, zipFixture(fixtureEntries()));
    const installation = (await core.request('market.import', { path })) as PresetInstallation;
    skillId = installation.skillIds[0]!;
    const [result] = (await core.request('market.members.create', {
      items: [
        {
          requestId: 'run',
          installationId: installation.id,
          configuration: {
            connectionId: connection.id,
            model: 'test',
            toolNames: ['read_skill', 'write_artifact'],
            approvalMode: 'ask',
            toolConnectionIds: [],
          },
        },
      ],
    })) as PresetMemberResult[];
    const member = core.state.storage.get<Bot>('bots', result!.botId!)!;
    const room = core.entities.createConversation({
      name: '技能工作',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0]!.id,
    });
    const { taskIds } = core.tasks.send({ conversationId: room.id, content: '整理材料' });
    await eventually(() =>
      ['completed', 'failed'].includes(
        core.state.storage.get<Task>('tasks', taskIds[0]!)?.status ?? '',
      ),
    );
    expect(core.state.storage.get<Task>('tasks', taskIds[0]!)?.status).toBe('completed');
    expect(core.state.snapshot().artifacts.some((item) => item.name === '材料清单.md')).toBe(true);
    const workspace = core.state.snapshot().workspaces[0]!;
    const first = sessionBinding(core.state, member, room, connection, workspace);
    const skill = core.state.storage.get<Skill>('skills', skillId)!;
    core.state.storage.put('skills', { ...skill, digest: 'b'.repeat(64) });
    expect(sessionBinding(core.state, member, room, connection, workspace).generation).toBe(
      first.generation + 1,
    );
  });
});
