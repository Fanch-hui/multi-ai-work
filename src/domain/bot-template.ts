import type { RoutineSchedule } from './routines.js';
import type { PortableSkill } from './work-skills.js';

export interface BotTemplate {
  format: 'multi-ai-work-bot';
  version: 1;
  name: string;
  role: string;
  instructions: string;
  personalInstructions?: string;
  color: string;
  suggestedToolNames?: string[];
  skills: PortableSkill[];
  routines: {
    name: string;
    goal: string;
    expectedOutput: string;
    schedule: RoutineSchedule;
    timeZone: string;
    missedRunPolicy: 'latest' | 'skip';
  }[];
}
