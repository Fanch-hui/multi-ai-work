import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Bot, MemoryEntry, Snapshot } from '../src/domain/types.js';
import { MemoryEditor } from '../apps/ui/src/MemoryEditor.js';

vi.mock('../apps/ui/src/components.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/ui/src/components.js')>()),
  Modal: ({ children }: { children: ReactNode }) => children,
}));

const bot = (id: string): Bot => ({
  id,
  name: id,
  role: '',
  instructions: '',
  connectionId: 'connection',
  model: 'model',
  color: 'blue',
  toolNames: [],
  skillIds: [],
  memoryMode: 'propose',
  revision: 1,
  archived: false,
});
const data: Snapshot = {
  bots: [bot('chief'), bot('member')],
  connections: [],
  conversations: [
    {
      id: 'team',
      name: '归档团队',
      kind: 'group',
      memberIds: ['chief', 'member'],
      workspaceId: 'workspace',
      archived: true,
      createdAt: '2026-10-13T12:00:00Z',
    },
  ],
  settings: {
    maxActiveRuns: 6,
    maxChildren: 5,
    maxCoordinationRounds: 0,
    trayEnabled: true,
    mainBotId: 'chief',
    autoAnswerMemberQuestions: true,
  },
  tasks: [],
  workspaces: [],
  messages: [],
  runs: [],
  approvals: [],
  artifacts: [],
  questions: [],
  processes: [],
  memories: [],
  events: [],
  toolConnections: [],
  skills: [],
  dataDirectory: '',
  bindings: [],
  checkpoints: [],
  compactions: [],
  taskPlans: [],
  taskInputs: [],
};
const render = (target?: Pick<MemoryEntry, 'scope' | 'ownerId'>, memory?: MemoryEntry) =>
  renderToStaticMarkup(
    createElement(MemoryEditor, {
      data,
      target,
      memory,
      mutate: async () => undefined as never,
      close: () => undefined,
    }),
  );

describe('memory editor notebook target', () => {
  it('starts a member notebook addition with that member and fixes its ownership', () => {
    const html = render({ scope: 'bot', ownerId: 'member' });
    expect(html).toContain('<option value="member" selected="">member</option>');
    expect(html.match(/<select[^>]*disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('<option value="team">');
    expect(html).not.toContain('<option value="shared">');
  });

  it('starts public notebook additions as shared with only public scopes available', () => {
    const html = render({ scope: 'shared', ownerId: 'shared' });
    expect(html).toContain('<option value="shared" selected="">共享资料</option>');
    expect(html).toContain('<option value="team">团队会话</option>');
    expect(html).not.toContain('<option value="bot">');
    expect(html).not.toContain('所属成员');
  });

  it('retains a team entry and its owner conversation when editing from public memory', () => {
    const memory: MemoryEntry = {
      id: 'memory',
      scope: 'team',
      ownerId: 'team',
      content: '已确认的约定',
      allowedConversationIds: ['team'],
      sourceIds: ['source'],
      status: 'approved',
      revision: 1,
      createdAt: '2026-10-13T12:00:00Z',
      updatedAt: '2026-10-13T12:00:00Z',
    };
    const html = render({ scope: 'shared', ownerId: 'shared' }, memory);
    expect(html).toContain('<option value="team" selected="">团队会话</option>');
    expect(html).toContain('归档团队');
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*checked=""/);
    expect(html).not.toContain('创建会话后可设置使用范围');
  });

  it('keeps the global addition free to choose a member or public scope', () => {
    const html = render();
    expect(html).toContain('<option value="chief" selected="">chief</option>');
    expect(html).toContain('<option value="team">团队会话</option>');
    expect(html).toContain('<option value="shared">共享资料</option>');
    expect(html.match(/<select[^>]*disabled=""/g)).toBeNull();
  });
});
