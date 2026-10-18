import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Bot, Skill, Snapshot } from '../src/domain/types.js';
import { Integrations } from '../apps/ui/src/Integrations.js';
import { BotEditor } from '../apps/ui/src/BotEditor.js';
import { sharedSkills, skillsForMember } from '../apps/ui/src/skill-lists.js';

vi.mock('../apps/ui/src/components.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../apps/ui/src/components.js')>(),
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
}));

const skill = (id: string, fields: Partial<Skill> = {}): Skill => ({ id, name: id,
  path: `/skills/${id}/SKILL.md`, content: '', ...fields });
const skills = [skill('Office', { bundled: true }), skill('手动导入'),
  skill('本成员技能', { presetOnly: true }), skill('其他成员技能', { presetOnly: true })];
const member: Bot = { id: 'member', name: '成员', role: '评审', instructions: '',
  connectionId: '', model: '', color: 'blue', toolNames: ['read_skill'], skillIds: ['本成员技能'],
  memoryMode: 'propose', revision: 1, archived: false,
  preset: { presetId: 'reviewer', version: '1', source: 'official', installationId: 'installed',
    baseInstructions: '', managedSkillIds: ['本成员技能'] } };
const data: Snapshot = { bots: [member], connections: [], conversations: [], workspaces: [],
  messages: [], tasks: [], runs: [], approvals: [], artifacts: [], questions: [], processes: [],
  memories: [], events: [], toolConnections: [], skills, bindings: [], checkpoints: [], compactions: [],
  taskPlans: [], taskInputs: [], dataDirectory: '', settings: { maxActiveRuns: 6, maxChildren: 5,
    maxCoordinationRounds: 0, trayEnabled: true, autoAnswerMemberQuestions: true } };
const mutate = async () => undefined as never;
const renderMember = (bot?: Bot) => renderToStaticMarkup(createElement(BotEditor, {
  bot, data, mutate, close: () => undefined,
}));

describe('market skill ownership in settings', () => {
  it('keeps global skills limited to bundled and manually imported skills', () => {
    expect(sharedSkills(skills).map(item => item.id)).toEqual(['Office', '手动导入']);
    const html = renderToStaticMarkup(createElement(Integrations, { data, mutate }));
    expect(html).toContain('Office');
    expect(html).toContain('删除手动导入');
    expect(html).not.toContain('本成员技能');
    expect(html).not.toContain('其他成员技能');
  });

  it('offers imported skills only for new, preset and detached members', () => {
    expect(skillsForMember(skills).map(item => item.id)).toEqual(['手动导入']);
    for (const bot of [undefined, member, { ...member, preset: undefined }]) {
      const html = renderMember(bot);
      expect(html).toContain('内置 Word、Excel、PPT、PDF 技能默认可用');
      expect(html).not.toContain('本成员技能');
      expect(html).not.toContain('其他成员技能');
      expect(html).not.toMatch(/<input[^>]*\/>Office/);
      expect(html).toMatch(/<input[^>]*type="checkbox"\/>手动导入/);
    }
  });
});
