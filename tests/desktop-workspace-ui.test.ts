import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CollaborationRequest } from '../src/domain/collaboration.js';
import type { WorkSkillDraft } from '../src/domain/work-skills.js';
import type { TaskWait } from '../src/domain/task-wait.js';
import {
  activeCollaborations,
  conversationSkillDrafts,
  recentCollaborations,
} from '../apps/ui/src/work-chat/WorkCards.js';
import { TaskWaitCard } from '../apps/ui/src/local-work/TaskWaitCard.js';

const mutate = async () => undefined as never;
describe('desktop workspace entry points', () => {
  it('shows only unsaved skill drafts belonging to the current conversation', () => {
    const drafts = [
      { id: 'current', sourceConversationId: 'room' },
      { id: 'private', sourceConversationId: 'other' },
      { id: 'saved', sourceConversationId: 'room', skillId: 'skill' },
      { id: 'library' },
    ] as WorkSkillDraft[];
    expect(conversationSkillDrafts(drafts, 'room').map((draft) => draft.id)).toEqual(['current']);
  });
  it('separates active handoffs from a bounded recent result list without changing source order', () => {
    const requests = [
      { id: 'waiting', status: 'requested', updatedAt: '2026-10-23T10:00:00Z' },
      { id: 'working', status: 'assigned', updatedAt: '2026-10-23T11:00:00Z' },
      ...[1, 2, 3, 4].map((day) => ({
        id: `done-${day}`,
        status: 'completed',
        updatedAt: `2026-10-2${day}T12:00:00Z`,
      })),
    ] as CollaborationRequest[];
    expect(activeCollaborations(requests).map((item) => item.id)).toEqual(['waiting', 'working']);
    expect(recentCollaborations(requests).map((item) => item.id)).toEqual([
      'done-4',
      'done-3',
      'done-2',
    ]);
    expect(requests[0].id).toBe('waiting');
  });
  it('opens computer handoff controls and preserves cancellation for the original task', () => {
    const wait = {
      id: 'wait',
      kind: 'computer-handoff',
      status: 'pending',
      summary: '请完成应用登录',
    } as TaskWait;
    const html = renderToStaticMarkup(
      createElement(TaskWaitCard, { wait, mutate, onComputer: () => {} }),
    );
    expect(html).toContain('打开电脑操作');
    expect(html).toContain('停止任务');
    expect(html).not.toContain('打开工作浏览器');
    expect(html).toContain('继续原任务');
  });
});
