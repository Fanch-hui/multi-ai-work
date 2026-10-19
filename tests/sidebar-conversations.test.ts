import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Conversation, Snapshot } from '../src/domain/types.js';
import { SidebarConversationList } from '../apps/ui/src/SidebarConversationList.js';
import { ArchivedConversations } from '../apps/ui/src/ArchivedConversations.js';

const conversations: Conversation[] = Array.from({ length: 7 }, (_, index) => ({
  id: `room-${index}`,
  name: `对话 ${index}`,
  purpose: 'chief',
  kind: 'private',
  memberIds: [],
  workspaceId: 'workspace',
  createdAt: `2026-10-14T12:0${index}:00Z`,
}));
const data = { conversations, bots: [], tasks: [] } as unknown as Snapshot;
const render = (selectedId?: string, query = '') =>
  renderToStaticMarkup(
    createElement(SidebarConversationList, {
      data,
      selectedId,
      query,
      archived: false,
      onSelect: () => undefined,
      onManage: () => undefined,
    }),
  );

describe('sidebar conversation limits', () => {
  it('shows five recent conversations with an expansion action', () => {
    const html = render();
    expect((html.match(/title="管理会话"/g) ?? []).length).toBe(5);
    expect(html).toContain('对话 6');
    expect(html).not.toContain('管理会话 对话 1');
    expect(html).toContain('展开显示');
  });

  it('keeps the selected older conversation visible within the five rows', () => {
    const html = render('room-0');
    expect((html.match(/title="管理会话"/g) ?? []).length).toBe(5);
    expect(html).toContain('管理会话 对话 0');
    expect(html).toContain('aria-current="page"');
  });

  it('shows all matching search results', () => {
    const html = render(undefined, '对话');
    expect((html.match(/title="管理会话"/g) ?? []).length).toBe(7);
    expect(html).not.toContain('展开显示');
  });

  it('keeps archived conversations in their separate settings list', () => {
    const archived = { ...conversations[0]!, id: 'archived', name: '历史会话', archived: true };
    const snapshot = { ...data, conversations: [...conversations, archived] };
    const html = renderToStaticMarkup(
      createElement(ArchivedConversations, {
        data: snapshot,
        mutate: async () => undefined as never,
        onSelectConversation: () => undefined,
      }),
    );
    expect(html).toContain('历史会话');
    expect(html).toContain('管理归档会话 历史会话');
    expect(html).not.toContain('对话 6');
  });
});
