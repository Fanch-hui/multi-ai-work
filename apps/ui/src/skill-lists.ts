import type { Skill } from '../../../src/domain/types.js';

export function sharedSkills(skills: Skill[]): Skill[] {
  return skills.filter(skill => !skill.presetOnly);
}

export function skillsForMember(skills: Skill[], boundSkillIds: string[] = []): Skill[] {
  const bound = new Set(boundSkillIds);
  return skills.filter(skill => !skill.presetOnly || bound.has(skill.id));
}
