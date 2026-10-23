import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bot, Skill } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import type { WorkSkillDraft } from '../src/domain/work-skills.js';
import { BackupService } from '../src/core/backup.js';
import { WorkSkillService } from '../src/core/work-skills.js';
import { BotTemplateService } from '../src/core/bot-templates.js';
import { validatePortableSkill } from '../src/core/work-skills-package.js';
import { setup } from './core-harness.js';

const skillInput = {
  name: '每周报告',
  description: '整理来源并写作报告',
  content: '# 每周报告\n\n1. 搜集已授权资料\n2. 标注来源\n3. 交付报告与复核清单\n',
};

async function fixture() {
  const result = await setup(async () => ({ text: '完成' }));
  result.core.scheduler.pause();
  const skills = new WorkSkillService(result.core.state);
  const templates = new BotTemplateService(
    result.core.state,
    result.core.entities,
    result.core.routines,
  );
  const draft = (await skills.request('workSkills.draft', { input: skillInput })) as WorkSkillDraft;
  const skill = (await skills.request('workSkills.save', {
    id: draft.id,
    input: skillInput,
  })) as Skill;
  return { ...result, skills, templates, draft, skill };
}

describe('工作技能与成员模板', () => {
  it('草稿持久保存，确认后安装资源，绑定仅更新技能', async () => {
    const { core, skills, skill, draft, bot } = await fixture();
    await expect(new WorkSkillService(core.state).request('workSkills.list')).resolves.toEqual([
      expect.objectContaining({ id: draft.id, skillId: skill.id }),
    ]);
    expect(await readFile(skill.path, 'utf8')).toBe(skillInput.content.trim());
    expect(skill.digest).toMatch(/^[a-f0-9]{64}$/);
    const member = bot('研究员', ['read_file']);
    await skills.request('workSkills.bind', { skillId: skill.id, botIds: [member.id] });
    const updated = core.state.storage.get<Bot>('bots', member.id)!;
    expect(updated.skillIds).toEqual([skill.id]);
    expect(updated.toolNames).toEqual(member.toolNames);
    expect(updated.approvalMode).toBe(member.approvalMode);
    expect(updated.toolConnectionIds).toEqual(member.toolConnectionIds);
  });

  it('编辑保存更新原技能与摘要，导出导入保留配套资源', async () => {
    const { core, skills, skill } = await fixture();
    await writeFile(join(skill.resourceRoot!, 'instructions.txt'), '长期工作约定');
    const changed = (await skills.request('workSkills.save', {
      skillId: skill.id,
      input: { ...skillInput, content: '# 更新后的技能\n\n按证据复核。' },
    })) as Skill;
    expect(changed.id).toBe(skill.id);
    expect(changed.digest).not.toBe(skill.digest);
    const exported = (await skills.request('workSkills.export', { skillId: skill.id })) as {
      content: string;
    };
    const imported = (await skills.request('workSkills.import', {
      content: exported.content,
    })) as Skill;
    expect(imported.id).not.toBe(skill.id);
    expect(imported.content).toBe(changed.content);
    expect(await readFile(join(imported.resourceRoot!, 'instructions.txt'), 'utf8')).toBe(
      '长期工作约定',
    );
    expect(core.state.storage.get<Skill>('skills', imported.id)?.digest).toBe(changed.digest);
  });

  it('市场配套技能与内置主管保持自身边界', async () => {
    const { core, skills, templates, skill, bot } = await fixture();
    core.state.storage.put('preset_installations', { id: 'market', skillIds: [skill.id] });
    await expect(skills.request('workSkills.export', { skillId: skill.id })).rejects.toThrow(
      '个人技能',
    );
    await expect(
      skills.request('workSkills.bind', { skillId: skill.id, botIds: [] }),
    ).rejects.toThrow('个人技能');
    const member = bot('作者');
    core.state.storage.put('bots', { ...member, skillIds: [skill.id] });
    const exported = (await templates.request('botTemplates.export', { botId: member.id })) as {
      content: string;
      omittedSkills: string[];
    };
    expect(JSON.parse(exported.content).skills).toEqual([]);
    expect(exported.omittedSkills).toEqual([skill.name]);
    await expect(
      templates.request('botTemplates.export', { botId: core.state.settings().mainBotId }),
    ).rejects.toThrow('普通成员');
  });

  it('模板预览及导入使用本机选择，例行工作暂停且原输入不迁移', async () => {
    const { core, skills, templates, skill, bot, connection } = await fixture();
    const member = bot('研究员', ['read_file', 'run_command']);
    await skills.request('workSkills.bind', { skillId: skill.id, botIds: [member.id] });
    const workspaceId = core.state.snapshot().workspaces[0]!.id;
    await core.routines.request('routines.save', {
      input: {
        name: '每日检查',
        botId: member.id,
        workspaceId,
        goal: '核查资料',
        expectedOutput: '报告',
        schedule: { kind: 'daily', time: '08:00' },
        timeZone: 'UTC',
        enabled: false,
      },
    });
    const exported = (await templates.request('botTemplates.export', { botId: member.id })) as {
      content: string;
    };
    const preview = (await templates.request('botTemplates.preview', {
      content: exported.content,
    })) as Record<string, unknown>;
    expect(preview).toMatchObject({ name: member.name, suggestedToolNames: member.toolNames });
    expect(preview).not.toHaveProperty('connectionId');
    expect(preview).not.toHaveProperty('model');
    expect(preview).not.toHaveProperty('memory');
    const imported = (await templates.request('botTemplates.import', {
      content: exported.content,
      input: { connectionId: connection.id, model: 'test', workspaceId, toolNames: ['read_file'] },
    })) as {
      bot: Bot;
      routines: { enabled: boolean; botId: string; inputArtifactIds: string[] }[];
    };
    expect(imported.bot.id).not.toBe(member.id);
    expect(imported.bot.toolNames).toEqual(['read_file']);
    expect(imported.bot.toolConnectionIds).toEqual([]);
    expect(imported.bot.approvalMode).toBe('ask');
    expect(imported.bot.skillIds).toHaveLength(1);
    expect(imported.bot.skillIds[0]).not.toBe(skill.id);
    expect(imported.routines).toEqual([
      expect.objectContaining({ enabled: false, botId: imported.bot.id, inputArtifactIds: [] }),
    ]);
  });

  it('非法连接导入回滚技能记录与资源', async () => {
    const { core, templates, bot, skills, skill } = await fixture();
    const member = bot('研究员');
    await skills.request('workSkills.bind', { skillId: skill.id, botIds: [member.id] });
    const exported = (await templates.request('botTemplates.export', { botId: member.id })) as {
      content: string;
    };
    const before = core.state.storage.all<Skill>('skills');
    await expect(
      templates.request('botTemplates.import', {
        content: exported.content,
        input: {
          connectionId: 'missing',
          model: 'test',
          workspaceId: core.state.snapshot().workspaces[0]!.id,
        },
      }),
    ).rejects.toThrow('连接不存在');
    expect(core.state.storage.all<Skill>('skills')).toEqual(before);
  });

  it('任务中生成草稿记录来源，运行中的成员不能被编辑技能打断', async () => {
    const { core, skills, skill, bot } = await fixture();
    const member = bot('资料员', ['read_file']);
    await skills.request('workSkills.bind', { skillId: skill.id, botIds: [member.id] });
    const room = core.entities.createConversation({
      name: '资料整理',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0]!.id,
    });
    const task = core.tasks.create({ conversationId: room.id, botId: member.id, goal: '整理资料' });
    const draft = skills.execute(skillInput, {
      task,
      conversation: room,
      botId: member.id,
    } as ToolExecutionContext);
    expect(draft).toMatchObject({
      sourceTaskId: task.id,
      sourceConversationId: room.id,
      authorBotId: member.id,
    });
    await expect(
      skills.request('workSkills.save', {
        skillId: skill.id,
        input: { ...skillInput, content: '新的工作要求' },
      }),
    ).rejects.toThrow('任务结束');
    expect(await readFile(skill.path, 'utf8')).toBe(skillInput.content.trim());
  });

  it('备份恢复草稿与个人技能资源，恢复后可继续编辑使用', async () => {
    const { core, skills, skill, draft } = await fixture();
    const backup = new BackupService(core.state);
    const saved = await backup.create();
    core.state.storage.delete('work_skill_drafts', draft.id);
    core.state.storage.delete('skills', skill.id);
    await backup.restore(saved.path);
    const restoredDrafts = (await skills.request('workSkills.list')) as WorkSkillDraft[];
    expect(restoredDrafts).toEqual([expect.objectContaining({ id: draft.id, skillId: skill.id })]);
    const restored = core.state.storage.get<Skill>('skills', skill.id)!;
    expect(restored.path).not.toBe(skill.path);
    expect(await readFile(restored.path, 'utf8')).toBe(skillInput.content.trim());
    const edited = (await skills.request('workSkills.save', {
      skillId: restored.id,
      input: { ...skillInput, content: '恢复后更新技能' },
    })) as Skill;
    expect(await readFile(edited.path, 'utf8')).toBe('恢复后更新技能');
  });

  it('并发编辑保留单一成功版本与一致资源', async () => {
    const { core, skills, skill } = await fixture();
    const edits = await Promise.allSettled([
      skills.request('workSkills.save', {
        skillId: skill.id,
        input: { ...skillInput, content: '第一份编辑' },
      }),
      skills.request('workSkills.save', {
        skillId: skill.id,
        input: { ...skillInput, content: '第二份编辑' },
      }),
    ]);
    expect(edits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = core.state.storage.get<Skill>('skills', skill.id)!;
    expect(['第一份编辑', '第二份编辑']).toContain(current.content);
    expect(await readFile(current.path, 'utf8')).toBe(current.content);
  });

  it('拒绝越界资源、重复路径及伪造来源', async () => {
    const { core, skills } = await fixture();
    const base64 = Buffer.from('content').toString('base64');
    expect(() =>
      validatePortableSkill({
        name: 'x',
        description: '',
        files: [{ path: '../SKILL.md', base64 }],
      }),
    ).toThrow('路径无效');
    expect(() =>
      validatePortableSkill({
        name: 'x',
        description: '',
        files: [
          { path: 'SKILL.md', base64 },
          { path: 'skill.md', base64 },
        ],
      }),
    ).toThrow('路径重复');
    expect(() =>
      skills.execute({ ...skillInput, sourceTaskId: 'other' }, {
        task: { id: 'current' },
      } as ToolExecutionContext),
    ).toThrow('当前任务');
    expect(core.state.storage.all('work_skill_drafts')).toHaveLength(1);
  });
});
