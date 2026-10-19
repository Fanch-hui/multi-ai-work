import { existsSync } from 'node:fs';
import type { Bot, Skill, Task } from '../../domain/types.js';
import type { State } from '../state.js';
import { terminal } from '../../domain/task-status.js';

export function requireIdleBot(state: State, botId: string) {
  if (
    state.storage.all<Task>('tasks').some((task) => task.botId === botId && !terminal(task.status))
  )
    throw new Error('成员还有未结束的任务，请完成或停止任务后重试');
}

export function combinedInstructions(base: string, personal?: string): string {
  return [base, personal?.trim() ? `个人补充要求：\n${personal.trim()}` : '']
    .filter(Boolean)
    .join('\n\n');
}

export function validateBotSkills(state: State, bot: Pick<Bot, 'skillIds'>) {
  for (const skillId of bot.skillIds) {
    const skill = state.storage.get<Skill>('skills', skillId);
    if (!skill) throw new Error('所选技能不存在，请重新选择');
    if (skill.missing || !existsSync(skill.path))
      throw new Error(`技能资源缺失：${skill.name}，请重新导入或下载`);
  }
}

export function protectPresetEdit(
  state: State,
  old: Bot | undefined,
  fields: {
    instructions: string;
    personalInstructions?: string;
    skillIds: string[];
  },
) {
  if (!old?.preset) return;
  if (old.preset.managedSkillIds.some((id) => !fields.skillIds.includes(id)))
    throw new Error('预设配套技能不能单独移除，可先转为自定义成员');
  if (
    fields.instructions !== old.instructions &&
    fields.instructions !== old.preset.baseInstructions
  )
    throw new Error('预设工作指令由版本管理，请填写个人补充要求或转为自定义成员');
  fields.personalInstructions ??= old.personalInstructions;
  fields.instructions = combinedInstructions(
    old.preset.baseInstructions,
    fields.personalInstructions,
  );
  if (
    fields.instructions !== old.instructions ||
    [...fields.skillIds].sort().join() !== [...old.skillIds].sort().join()
  )
    requireIdleBot(state, old.id);
}
