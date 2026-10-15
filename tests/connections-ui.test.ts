import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Connection, Snapshot } from '../src/domain/types.js';
import { Connections } from '../apps/ui/src/Connections.js';

const connection: Connection = { id: 'connection', name: 'ChatGPT', provider: 'chatgpt', authMode: 'oauth',
  secretRef: 'fixture-reference', concurrency: 1, status: 'error', error: '授权请求失败（HTTP 403）',
  models: [], revision: 1, createdAt: '2026-10-12T12:00:00Z' };

function render(item: Connection) {
  const data: Snapshot = { connections: [item], bots: [], tasks: [], conversations: [], workspaces: [],
    messages: [], runs: [], approvals: [], artifacts: [], questions: [], processes: [], memories: [], events: [],
    toolConnections: [], skills: [], bindings: [], checkpoints: [], compactions: [], taskPlans: [], taskInputs: [], dataDirectory: '',
    settings: { maxActiveRuns: 3, maxChildren: 5, maxCoordinationRounds: 0, trayEnabled: true,
      autoAnswerMemberQuestions: true } };
  return renderToStaticMarkup(createElement(Connections, { data, mutate: async () => undefined as never }));
}

describe('ChatGPT connection recovery', () => {
  it('lets a saved login retry a connection error without opening sign-in', () => {
    const html = render(connection);
    expect(html).toContain('检测连接');
    expect(html).not.toContain('完成连接');
    expect(html).toContain(connection.error);
  });

  it('offers sign-in when credentials are missing or confirmed unusable', () => {
    for (const item of [{ ...connection, secretRef: undefined }, { ...connection, status: 'needs_auth' as const }]) {
      const html = render(item);
      expect(html).toContain('完成连接');
      expect(html).not.toContain('检测连接');
    }
  });
});
