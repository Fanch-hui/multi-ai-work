import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot, Connection, Snapshot } from '../src/domain/types.js';
import { Agents } from '../apps/ui/src/Agents.js';
import { modelLabel } from '../apps/ui/src/model-label.js';
import { qoderCatalog } from '../src/providers/native/qoder.js';

const connection: Connection = {
  id: 'qoder',
  name: 'Qoder CN',
  provider: 'qoder',
  concurrency: 1,
  status: 'ready',
  revision: 1,
  createdAt: '',
  models: qoderCatalog([{ value: 'qfmodel', displayName: '目录模型名称', description: '' }]),
};
const member: Bot = {
  id: 'member',
  name: '成员',
  role: '',
  instructions: '',
  connectionId: connection.id,
  model: 'qfmodel',
  color: '',
  toolNames: [],
  skillIds: [],
  memoryMode: 'off',
  revision: 1,
  archived: false,
};

describe('model catalog display names', () => {
  it('renders the official catalog name on a member card while retaining the selected model ID', () => {
    const data: Snapshot = {
      connections: [connection],
      bots: [member],
      tasks: [],
      conversations: [],
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
      bindings: [],
      checkpoints: [],
      compactions: [],
      taskPlans: [],
      taskInputs: [],
      dataDirectory: '',
      settings: {
        maxActiveRuns: 6,
        maxChildren: 5,
        maxCoordinationRounds: 0,
        trayEnabled: true,
        autoAnswerMemberQuestions: true,
      },
    };
    const html = renderToStaticMarkup(
      createElement(Agents, {
        data,
        mutate: async () => undefined as never,
        openChief: () => {},
        configureConnection: () => {},
        openMarket: () => {},
      }),
    );
    expect(html).toContain('目录模型名称');
    expect(html).not.toContain('qfmodel');
    expect(member.model).toBe('qfmodel');
  });

  it('keeps unidentified IDs visible and shows a configuration prompt only when no ID is selected', () => {
    expect(modelLabel(connection, 'not-in-catalog')).toBe('not-in-catalog');
    expect(modelLabel(undefined, 'custom-model')).toBe('custom-model');
    expect(modelLabel(connection, '')).toBe('待配置模型');
    expect(modelLabel(connection, undefined, '配置模型')).toBe('配置模型');
  });
});
