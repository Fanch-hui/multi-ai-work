import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../src/domain/types.js';
import { initializeConversationReads } from '../src/core/conversation-read.js';
import { State } from '../src/core/state.js';
import { setup } from './core-harness.js';

const time = '2026-10-13T10:00:00Z';
const message = (
  id: string,
  conversationId: string,
  values: Partial<Message> = {},
): Omit<Message, 'sequence'> => ({
  id,
  conversationId,
  authorType: 'bot',
  authorBotId: 'member',
  content: id,
  artifactIds: [],
  status: 'committed',
  createdAt: time,
  ...values,
});

describe('conversation read receipts', () => {
  it('counts incoming replies in main, group and private conversations, and keeps read state after restart', async () => {
    const { core, root } = await setup(async () => ({ text: '完成' }));
    const main = core.state.snapshot().conversations.find((room) => room.purpose === 'chief')!;
    const rooms: Conversation[] = [
      main,
      { ...main, id: 'group', purpose: 'task', name: '群聊', kind: 'group' },
      { ...main, id: 'private', purpose: undefined, name: '私聊' },
    ];
    for (const room of rooms) {
      core.state.storage.put('conversations', room);
      core.state.storage.appendMessage(message(`${room.id}:reply`, room.id));
      core.state.storage.appendMessage(message(`${room.id}:own`, room.id, { authorType: 'user' }));
      core.state.storage.appendMessage(
        message(`${room.id}:status`, room.id, { authorType: 'system' }),
      );
      core.state.storage.appendMessage(
        message(`${room.id}:empty`, room.id, { content: '', status: 'draft' }),
      );
    }
    const counts = (state: State) =>
      rooms.map(
        (room) => state.snapshot().conversations.find((item) => item.id === room.id)?.unreadCount,
      );
    expect(counts(core.state)).toEqual([1, 1, 1]);
    await core.request('conversations.read', { id: main.id, messageIds: [`${main.id}:reply`] });
    expect(
      core.state.snapshot().conversations.find((room) => room.id === main.id)?.unreadCount,
    ).toBe(0);
    const restarted = new State(root);
    try {
      expect(counts(restarted)).toEqual([0, 1, 1]);
    } finally {
      restarted.storage.close();
    }
  });

  it('retains unseen parallel drafts below the reading cursor without counting streaming chunks separately', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const room = core.state.snapshot().conversations[0],
      s = core.state.storage;
    const draft = s.appendMessage(message('stream', room.id, { content: '', status: 'draft' }));
    s.appendMessage(message('other', room.id));
    await core.request('conversations.read', { id: room.id, messageIds: ['other'] });
    s.updateMessage({ ...draft, content: '开始输出' });
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(1);
    s.updateMessage({ ...draft, content: '开始输出更多文字' });
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(1);
    await core.request('conversations.read', { id: room.id, messageIds: ['other', 'stream'] });
    s.updateMessage({ ...draft, content: '最终内容', status: 'committed' });
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(0);
    s.appendMessage(message('attachment', room.id, { content: '', artifactIds: ['file'] }));
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(1);
  });

  it('acknowledges only observed message IDs and rejects cross-conversation receipts', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const room = core.state.snapshot().conversations[0],
      s = core.state.storage;
    s.put('conversations', { ...room, id: 'other' });
    s.appendMessage(message('seen', room.id));
    s.appendMessage(message('new', room.id));
    s.appendMessage(message('foreign', 'other'));
    await core.request('conversations.read', { id: room.id, messageIds: ['seen'] });
    expect(
      core.state.snapshot().conversations.find((item) => item.id === room.id)?.unreadCount,
    ).toBe(1);
    await expect(
      core.request('conversations.read', { id: room.id, messageIds: ['foreign'] }),
    ).rejects.toThrow('管家时间线');
    expect(
      core.state.snapshot().conversations.find((item) => item.id === 'other')?.unreadCount,
    ).toBe(1);
  });

  it('retains a viewed progress bubble and keeps the newly published reply unread', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const room = core.state.snapshot().conversations[0],
      s = core.state.storage;
    const draft = s.appendMessage(message('stream', room.id, { status: 'draft', runId: 'run' }));
    await core.request('conversations.read', { id: room.id, messageIds: ['stream'] });
    const published = core.tasks.post(room.id, 'member', 'run', '正式群聊发言');
    expect(published.sequence).toBeGreaterThan(draft.sequence);
    const progress = { ...draft, status: 'committed' };
    expect(s.getMessage(draft.id)).toEqual(progress);
    expect(s.messages(room.id).filter((item) => item.authorType === 'bot')).toEqual([
      progress,
      published,
    ]);
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(1);
    await core.request('conversations.read', { id: room.id, messageIds: [draft.id] });
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(1);
    await core.request('conversations.read', { id: room.id, messageIds: [published.id] });
    expect(core.state.snapshot().conversations[0].unreadCount).toBe(0);
  });

  it('initializes earlier history once and removes the receipt when a conversation is deleted', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    const s = core.state.storage;
    const room = s.put('conversations', {
      ...core.state.snapshot().conversations[0],
      id: 'legacy-chief',
      chiefRole: 'history' as const,
      chiefContextId: undefined,
    });
    s.appendMessage(message('history', room.id));
    s.setMetadata('conversation-reads-v1', false);
    initializeConversationReads(s);
    expect(
      core.state.snapshot().conversations.find((item) => item.id === room.id)?.unreadCount,
    ).toBe(0);
    s.appendMessage(message('new', room.id));
    initializeConversationReads(s);
    expect(
      core.state.snapshot().conversations.find((item) => item.id === room.id)?.unreadCount,
    ).toBe(1);
    await core.conversations.delete(room.id);
    expect(s.metadata(`conversation-read:${room.id}`)).toBeUndefined();
    expect(s.metadata(`message-sequence:${room.id}`)).toBeUndefined();
  });
});
