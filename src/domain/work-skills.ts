export interface WorkSkillDraft {
  id: string;
  name: string;
  description: string;
  content: string;
  sourceTaskId?: string;
  sourceConversationId?: string;
  authorBotId?: string;
  skillId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortableSkill {
  name: string;
  description: string;
  files: { path: string; base64: string }[];
}
