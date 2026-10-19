import type { Skill } from '../../../src/domain/types.js';

export function sharedSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => !skill.presetOnly);
}

export function skillsForMember(skills: Skill[]): Skill[] {
  return skills.filter((skill) => !skill.bundled && !skill.presetOnly);
}
