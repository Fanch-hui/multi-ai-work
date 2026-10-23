import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { BotTemplate } from '../domain/bot-template.js';
import { routineInputSchema } from '../domain/routine-input.js';
import type { Routine } from '../domain/routines.js';
import type { Bot, Skill, Workspace } from '../domain/types.js';
import { required } from './errors.js';
import type { EntityService } from './entities.js';
import type { RoutineService } from './routines.js';
import { validateRoutineSchedule } from './routines-time.js';
import { presetSkillIds } from './skills.js';
import type { State } from './state.js';
import {
  exportPortableSkill,
  installPortableSkill,
  portableSkillSchema,
  validatePortableSkill,
} from './work-skills-package.js';

const routineSchema = routineInputSchema.omit({
  id: true,
  botId: true,
  workspaceId: true,
  inputArtifactIds: true,
  enabled: true,
});
const templateSchema = z
  .object({
    format: z.literal('multi-ai-work-bot'),
    version: z.literal(1),
    name: z.string().trim().min(1).max(120),
    role: z.string().max(200),
    instructions: z.string().max(80000),
    personalInstructions: z.string().max(20000).optional(),
    color: z.string().max(40),
    suggestedToolNames: z.array(z.string().max(120)).max(100).optional(),
    skills: z.array(portableSkillSchema).max(30),
    routines: z.array(routineSchema).max(30),
  })
  .strict();

export class BotTemplateService {
  constructor(
    private state: State,
    private entities: EntityService,
    private routines?: RoutineService,
  ) {}

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'botTemplates.export') return this.export(z.string().parse(params.botId));
    if (method === 'botTemplates.preview') return this.parse(params.content);
    if (method === 'botTemplates.import') return this.install(params);
    throw new Error(`未知成员模板操作：${method}`);
  }

  private parse(content: unknown): BotTemplate {
    const text = z
      .string()
      .max(24 * 1024 * 1024)
      .parse(content);
    const template = templateSchema.parse(JSON.parse(text));
    let total = 0;
    for (const skill of template.skills) {
      validatePortableSkill(skill);
      total += skill.files.reduce((sum, file) => sum + Buffer.byteLength(file.base64, 'base64'), 0);
    }
    if (total > 16 * 1024 * 1024) throw new Error('模板技能资源总上限为 16 MiB');
    for (const routine of template.routines)
      validateRoutineSchedule(routine.schedule, routine.timeZone);
    return template;
  }

  private async export(botId: string) {
    if (botId === this.state.settings().mainBotId) throw new Error('请选择普通成员分享模板');
    const bot = required(this.state.storage.get<Bot>('bots', botId), '成员不存在');
    const privateIds = presetSkillIds(this.state),
      skills: BotTemplate['skills'] = [],
      omittedSkills: string[] = [];
    for (const skillId of bot.skillIds) {
      const skill = this.state.storage.get<Skill>('skills', skillId);
      if (!skill) continue;
      if (skill.bundled) continue;
      if (skill.missing || privateIds.has(skillId)) {
        omittedSkills.push(skill.name);
        continue;
      }
      skills.push(await exportPortableSkill(skill));
    }
    const routines = this.state.storage
      .all<Routine>('routines')
      .filter((routine) => routine.botId === botId)
      .map(({ name, goal, expectedOutput, schedule, timeZone, missedRunPolicy }) => ({
        name,
        goal,
        expectedOutput,
        schedule,
        timeZone,
        missedRunPolicy,
      }));
    const template: BotTemplate = {
      format: 'multi-ai-work-bot',
      version: 1,
      name: bot.name,
      role: bot.role,
      instructions: bot.instructions,
      personalInstructions: bot.personalInstructions,
      color: bot.color,
      suggestedToolNames: bot.toolNames,
      skills,
      routines,
    };
    const content = JSON.stringify(template, null, 2);
    this.parse(content);
    return { name: `${bot.name}.bot.json`, content, omittedSkills };
  }

  private async install(params: Record<string, unknown>) {
    const template = this.parse(params.content);
    const input = z
      .object({
        connectionId: z.string(),
        model: z.string().min(1),
        reasoning: z.string().optional(),
        workspaceId: z.string(),
        name: z.string().trim().min(1).max(120).optional(),
        toolNames: z.array(z.string()).max(100).default([]),
      })
      .parse(params.input);
    required(
      this.state.storage.get<Workspace>('workspaces', input.workspaceId),
      '请选择本机工作区',
    );
    if (template.routines.length && !this.routines) throw new Error('例行工作服务尚未就绪');
    const installed: Skill[] = [];
    let createdBotId: string | undefined;
    try {
      for (const portable of template.skills)
        installed.push(await installPortableSkill(this.state, portable));
      const result = this.state.storage.transaction(() => {
        for (const skill of installed) this.state.storage.put('skills', skill);
        const bot = this.entities.saveBot({
          name: input.name ?? template.name,
          role: template.role,
          instructions: template.instructions,
          personalInstructions: template.personalInstructions,
          color: template.color,
          connectionId: input.connectionId,
          model: input.model,
          reasoning: input.reasoning,
          toolNames: input.toolNames,
          approvalMode: 'ask',
          toolConnectionIds: [],
          skillIds: installed.map((skill) => skill.id),
          memoryMode: 'propose',
        });
        return { bot, workspaceId: input.workspaceId };
      });
      createdBotId = result.bot.id;
      const routines: Routine[] = [];
      for (const routine of template.routines)
        routines.push(
          (await this.routines!.request('routines.save', {
            input: {
              ...routine,
              botId: result.bot.id,
              workspaceId: input.workspaceId,
              inputArtifactIds: [],
              enabled: false,
            },
          })) as Routine,
        );
      this.state.changed();
      return { ...result, routines };
    } catch (error) {
      this.state.storage.transaction(() => {
        if (createdBotId) {
          for (const routine of this.state.storage
            .all<Routine>('routines')
            .filter((item) => item.botId === createdBotId)) {
            this.state.storage.delete('conversations', routine.conversationId);
            this.state.storage.delete('routines', routine.id);
          }
          this.state.storage.delete('bots', createdBotId);
        }
        for (const skill of installed) this.state.storage.delete('skills', skill.id);
      });
      for (const skill of installed)
        await rm(skill.resourceRoot!, { recursive: true, force: true });
      this.state.changed();
      throw error;
    }
  }
}
