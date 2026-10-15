import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Snapshot, Task } from '../src/domain/types.js';
import { MainSidebar } from '../apps/ui/src/MainSidebar.js';
import { ConversationReadReceipts, readableBotMessageIds } from '../apps/ui/src/conversation-read.js';
import { conversationCanBeRead } from '../apps/ui/src/useConversationRead.js';

const time = '2026-10-13T10:00:00Z';
const message = (id: string, values: Partial<Message> = {}): Message => ({ id, conversationId: 'room', sequence: 1,
  authorType: 'bot', authorBotId: 'member', content: '回复', artifactIds: [], status: 'committed', createdAt: time, ...values });
const room = (id: string, values: Partial<Conversation> = {}): Conversation => ({ id, name: id, kind: 'group',
  memberIds: [], workspaceId: 'workspace', createdAt: time, ...values });

describe('conversation read receipts', () => {
  it('acknowledges only bot messages with displayed content or attachments in this conversation', () => {
    expect(readableBotMessageIds([message('reply'), message('stream', { status: 'draft' }),
      message('files', { content: '', artifactIds: ['file'] }), message('empty', { content: '  ', status: 'draft' }),
      message('user', { authorType: 'user' }), message('system', { authorType: 'system' }),
      message('other', { conversationId: 'other' })], 'room')).toEqual(['reply', 'stream', 'files']);
  });

  it('requires a visible focused message view, preserving unread state in records and background windows', () => {
    expect(conversationCanBeRead(true, true, true)).toBe(true);
    expect(conversationCanBeRead(false, true, true)).toBe(false);
    expect(conversationCanBeRead(true, false, true)).toBe(false);
    expect(conversationCanBeRead(true, true, false)).toBe(false);
  });

  it('deduplicates streaming snapshots and sends newly displayed messages after the active receipt', async () => {
    const receipts = new ConversationReadReceipts();
    const sent: { id: string; messageIds: string[] }[] = [];
    let complete!: () => void;
    const send = async (params: { id: string; messageIds: string[] }) => {
      sent.push(params);
      await new Promise<void>(resolve => { complete = resolve; });
    };
    const first = receipts.mark('room', ['reply', 'reply'], send);
    expect(await receipts.mark('room', ['reply', 'new'], send)).toBe(false);
    expect(sent).toEqual([{ id: 'room', messageIds: ['reply'] }]);
    complete();
    expect(await first).toBe(true);
    expect(await receipts.mark('room', ['reply'], send)).toBe(false);
    const next = receipts.mark('room', ['reply', 'new'], send);
    expect(sent[1]).toEqual({ id: 'room', messageIds: ['new'] });
    complete();
    expect(await next).toBe(true);
  });

  it('retains unacknowledged messages after a failed request and allows recovery', async () => {
    const receipts = new ConversationReadReceipts();
    await expect(receipts.mark('room', ['reply'], async () => { throw new Error('断开'); })).rejects.toThrow('断开');
    const sent: unknown[] = [];
    expect(await receipts.mark('room', ['reply'], async params => { sent.push(params); })).toBe(true);
    expect(sent).toEqual([{ id: 'room', messageIds: ['reply'] }]);
  });
});

describe('conversation unread badges', () => {
  it('shows all conversation types, caps the visible number and keeps task activity separate', () => {
    const data: Snapshot = { conversations: [room('主管', { kind: 'private', purpose: 'chief', unreadCount: 2 }),
      room('群聊', { unreadCount: 120 }), room('私聊', { kind: 'private', unreadCount: 1 }), room('已读', { unreadCount: 0 })],
      tasks: [{ conversationId: '群聊', status: 'running' } as Task], bots: [], connections: [], workspaces: [],
      messages: [], runs: [], approvals: [], artifacts: [], questions: [], processes: [], memories: [], events: [],
      toolConnections: [], skills: [], bindings: [], checkpoints: [], compactions: [], taskPlans: [], taskInputs: [], dataDirectory: '',
      settings: { maxActiveRuns: 6, maxChildren: 5, maxCoordinationRounds: 0, trayEnabled: true, autoAnswerMemberQuestions: true } };
    const html = renderToStaticMarkup(createElement(MainSidebar, { data, page: 'chat', selectedId: '主管',
      onPage: () => undefined, onSelect: () => undefined, onCreate: () => undefined, onCreateGroup: () => undefined,
      onCollapse: () => undefined, mutate: async () => undefined as never }));
    expect(html).toContain('aria-label="2 条未读消息"');
    expect(html).toContain('aria-label="120 条未读消息"');
    expect(html).toContain('aria-label="1 条未读消息"');
    expect(html).toContain('>99+</span>');
    expect(html).not.toContain('aria-label="0 条未读消息"');
    expect(html).toContain('aria-label="有进行中的任务"');
  });
});
