import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Bot, Skill, Task } from '../domain/types.js';
import { terminal } from '../domain/task-status.js';
import type { WorkSkillDraft } from '../domain/work-skills.js';
import { required } from './errors.js';
import { parseSkillMetadata } from './market/package-resources.js';
import { presetSkillIds } from './skills.js';
import { id, now, type State } from './state.js';
import { exportPortableSkill, installPortableSkill } from './work-skills-package.js';

const fields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  content: z.string().trim().min(1).max(120000),
});

export class WorkSkillService {
  constructor(private state: State) {}

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const storage = this.state.storage;
    if (method === 'workSkills.list') return storage.all<WorkSkillDraft>('work_skill_drafts');
    if (method === 'workSkills.get') return this.draft(String(params.id));
    if (method === 'workSkills.draft') return this.create(params.input);
    if (method === 'workSkills.discard') {
      const draft = this.draft(String(params.id));
      storage.delete('work_skill_drafts', draft.id);
      this.state.changed();
      return { discarded: true };
    }
    if (method === 'workSkills.save') return this.save(params);
    if (method === 'workSkills.bind') return this.bind(params);
    if (method === 'workSkills.import') {
      const text = z
        .string()
        .max(24 * 1024 * 1024)
        .parse(params.content);
      const portable = z
        .object({
          format: z.literal('multi-ai-work-skill'),
          version: z.literal(1),
          skill: z.unknown(),
        })
        .strict()
        .parse(JSON.parse(text));
      const skill = await installPortableSkill(this.state, portable.skill);
      storage.put('skills', skill);
      this.state.changed();
      return skill;
    }
    if (method === 'workSkills.export') {
      const skill = this.shareable(String(params.skillId));
      return {
        name: `${skill.name}.skill.json`,
        content: JSON.stringify(
          { format: 'multi-ai-work-skill', version: 1, skill: await exportPortableSkill(skill) },
          null,
          2,
        ),
      };
    }
    throw new Error(`未知技能操作：${method}`);
  }

  execute(args: Record<string, unknown>, context: ToolExecutionContext) {
    context.assertAuthorized?.();
    const sourceTaskId =
      args.sourceTaskId === undefined ? context.task.id : z.string().parse(args.sourceTaskId);
    if (sourceTaskId !== context.task.id) throw new Error('只能从当前任务生成技能草稿');
    context.markDispatched?.();
    return this.create(args, {
      sourceTaskId,
      sourceConversationId: context.conversation.id,
      authorBotId: context.botId,
    });
  }

  private create(input: unknown, source: Partial<WorkSkillDraft> = {}): WorkSkillDraft {
    const parsed = fields.parse(input);
    this.validateContent(parsed.content);
    const draft: WorkSkillDraft = {
      ...parsed,
      ...source,
      id: id(),
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.storage.put('work_skill_drafts', draft);
    this.state.changed();
    return draft;
  }

  private draft(draftId: string) {
    return required(
      this.state.storage.get<WorkSkillDraft>('work_skill_drafts', draftId),
      '技能草稿不存在',
    );
  }

  private shareable(skillId: string) {
    const skill = required(this.state.storage.get<Skill>('skills', skillId), '技能不存在');
    if (skill.bundled || skill.missing || presetSkillIds(this.state).has(skill.id))
      throw new Error('请选择可编辑和分享的个人技能');
    return skill;
  }

  private validateContent(content: string) {
    if (Buffer.byteLength(content) > 128000) throw new Error('技能正文超过 128 KB');
    parseSkillMetadata(content);
  }

  private async save(params: Record<string, unknown>) {
    const parsed = fields.parse(params.input),
      draft = params.id ? this.draft(String(params.id)) : undefined;
    this.validateContent(parsed.content);
    const old = params.skillId ? this.shareable(String(params.skillId)) : undefined;
    if (old)
      this.assertIdle(
        this.state.storage
          .all<Bot>('bots')
          .filter((bot) => bot.skillIds.includes(old.id))
          .map((bot) => bot.id),
      );
    const portable = old
      ? await exportPortableSkill(old)
      : { name: parsed.name, description: parsed.description, files: [] };
    portable.name = parsed.name;
    portable.description = parsed.description;
    portable.files = [
      ...portable.files.filter((file) => file.path !== 'SKILL.md'),
      { path: 'SKILL.md', base64: Buffer.from(parsed.content).toString('base64') },
    ];
    const installed = await installPortableSkill(this.state, portable);
    const skill = { ...installed, id: old?.id ?? installed.id };
    try {
      this.state.storage.transaction(() => {
        if (old) {
          const current = this.shareable(old.id);
          if (current.resourceRoot !== old.resourceRoot || current.digest !== old.digest)
            throw new Error('技能已被更新，请刷新后重试');
          this.assertIdle(
            this.state.storage
              .all<Bot>('bots')
              .filter((bot) => bot.skillIds.includes(old.id))
              .map((bot) => bot.id),
          );
        }
        this.state.storage.put('skills', skill);
        if (draft)
          this.state.storage.put('work_skill_drafts', {
            ...draft,
            ...parsed,
            skillId: skill.id,
            updatedAt: now(),
          });
      });
    } catch (error) {
      await rm(installed.resourceRoot!, { recursive: true, force: true });
      throw error;
    }
    const previousRoot = old?.resourceRoot;
    if (
      previousRoot &&
      dirname(previousRoot) === join(this.state.dataDirectory, 'skills') &&
      !this.state.storage.all<Skill>('skills').some((item) => item.resourceRoot === previousRoot)
    ) {
      await rm(previousRoot, { recursive: true, force: true });
    }
    this.state.changed();
    return skill;
  }

  private bind(params: Record<string, unknown>) {
    const skill = this.shareable(z.string().parse(params.skillId));
    const botIds = z.array(z.string()).max(100).parse(params.botIds);
    const bots = botIds.map((botId) =>
      required(this.state.storage.get<Bot>('bots', botId), '成员不存在'),
    );
    if (bots.some((bot) => bot.archived)) throw new Error('成员已归档');
    this.assertIdle(botIds);
    this.state.storage.transaction(() => {
      for (const bot of bots)
        this.state.storage.put('bots', {
          ...bot,
          skillIds: [...new Set([...bot.skillIds, skill.id])],
          revision: bot.revision + 1,
        });
    });
    this.state.changed();
    return { skillId: skill.id, botIds };
  }

  private assertIdle(botIds: string[]) {
    if (
      this.state.storage
        .all<Task>('tasks')
        .some((task) => botIds.includes(task.botId) && !terminal(task.status))
    )
      throw new Error('请等待相关成员的任务结束后再更新技能');
  }
}
