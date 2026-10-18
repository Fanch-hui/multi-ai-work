import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run, Task } from '../src/domain/types.js';
import type { MessagePage, SnapshotDelta, SnapshotView } from '../src/domain/snapshot-sync.js';
import { State } from '../src/core/state.js';
import { setup } from './core-harness.js';

const resources: { state: State; root: string }[] = [];
function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-sync-')), state = new State(root);
  resources.push({ state, root });
  const room = state.snapshot().conversations[0];
  state.changed();
  return { state, s: state.storage, room };
}
function message(id: string, conversationId: string, more: Partial<Message> = {}): Omit<Message, 'sequence'> {
  return { id, conversationId, authorType: 'bot', content: id, artifactIds: [], status: 'committed', createdAt: new Date().toISOString(), ...more };
}
afterEach(() => { vi.restoreAllMocks(); for (const { state, root } of resources.splice(0)) { state.storage.close(); rmSync(root, { recursive: true, force: true }); } });

describe('versioned UI snapshots', () => {
  it('pages only selected history while preserving complete legacy snapshots and global unread counts', () => {
    const { state, s, room } = stateFixture();
    s.put('conversations', { ...room, id: 'another' });
    for (let i = 1; i <= 125; i++) s.appendMessage(message(`m${i}`, room.id));
    s.appendMessage(message('foreign', 'another')); state.changed();
    const all = state.snapshot(), readMessages = vi.spyOn(s, 'messages');
    const view = state.sync.view(room.id);
    expect(readMessages).not.toHaveBeenCalled();
    expect(view.snapshot.messages).toHaveLength(50);
    expect(view.history?.nextBefore).toBe(76);
    expect(view.snapshot.conversations).toEqual(all.conversations);
    expect(all.messages).toHaveLength(126);
    const previous = s.messagePage(room.id, view.history!.nextBefore);
    expect(previous.messages.map(item => item.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 26));
    s.appendMessage(message('newest', room.id));
    const first = s.messagePage(room.id, previous.nextBefore);
    expect(first.messages).toHaveLength(25);
    expect(first.nextBefore).toBeUndefined();
    expect(new Set([...first.messages, ...previous.messages, ...view.snapshot.messages].map(item => item.id)).size).toBe(125);
  });

  it('returns the same saved fragment replacement, run status and activity to independent readers without full scans', () => {
    const { state, s, room } = stateFixture();
    const task: Task = { id: 'task', conversationId: room.id, botId: 'bot', dependencyIds: [], goal: 'work', expectedOutput: '', status: 'running',
      runIds: ['run'], artifactIds: [], requestId: 'request', depth: 0, createdAt: '2026-10-15', updatedAt: '2026-10-15' };
    const run: Run = { id: 'run', taskId: task.id, botId: 'bot', bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '2026-10-15' };
    s.put('tasks', task); s.put('runs', run);
    const draft = s.appendMessage(message('stream', room.id, { status: 'draft', runId: run.id, content: '' }));
    state.changed(); const initial = state.sync.view(room.id);
    s.messageStream.append({ id: 'text', runId: run.id, type: 'text', data: { delta: '已保存尾文' }, createdAt: '2026-10-16' }, draft.id);
    s.put('runs', { ...run, contextUsage: { estimatedTokens: 42 } }); state.changed('content');
    const readMessages = vi.spyOn(s, 'messages'), all = vi.spyOn(s, 'all');
    const delta = state.sync.delta(initial.cursor, room.id);
    expect(delta.reset).toBeUndefined();
    expect(delta.messages[0].content).toBe('已保存尾文');
    expect(delta.tasks[0].activity?.phase).toBe('responding');
    expect(delta.runs[0].contextUsage?.estimatedTokens).toBe(42);
    expect(delta.conversations?.find(item => item.id === room.id)?.unreadCount).toBe(1);
    expect(state.sync.delta(initial.cursor, room.id)).toEqual(delta);
    expect(readMessages).not.toHaveBeenCalled();
    expect(all.mock.calls.some(([table]) => table === 'tasks' || table === 'runs')).toBe(false);
    expect(state.sync.delta(delta.cursor, room.id).messages).toEqual([]);
  });

  it('preserves the event cursor through Core RPC and updates activity for text without run writes', async () => {
    const { core } = await setup(async () => ({ text: '' }));
    const state = core.state, s = state.storage, room = state.snapshot().conversations[0];
    const task: Task = { id: 'stream-task', conversationId: room.id, botId: 'bot', dependencyIds: [], goal: 'work', expectedOutput: '', status: 'running',
      runIds: ['stream-run'], artifactIds: [], requestId: 'stream-request', depth: 0, createdAt: '2026-10-18', updatedAt: '2026-10-18' };
    const run: Run = { id: 'stream-run', taskId: task.id, botId: 'bot', bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '2026-10-18' };
    s.put('tasks', task); s.put('runs', run);
    s.event({ id: 'model-start', runId: run.id, type: 'status', data: { phase: 'model-start' }, createdAt: '2026-10-18T12:00:00Z' });
    const draft = s.appendMessage(message('rpc-stream', room.id, { status: 'draft', runId: run.id, content: '' }));
    state.changed();
    const view = await core.request('state.view', { conversationId: room.id }) as SnapshotView;
    expect(view.snapshot.tasks.find(item => item.id === task.id)?.activity?.phase).toBe('model');
    const events = vi.spyOn(s, 'events'), eventsAfter = vi.spyOn(s, 'eventsAfter');
    const createdAt = '2026-10-18T12:00:01Z';
    s.messageStream.append({ id: 'rpc-text', runId: run.id, type: 'text', data: { delta: 'live text' }, createdAt }, draft.id);
    state.changed('content');
    const delta = await core.request('state.changes', { cursor: view.cursor, conversationId: room.id }) as SnapshotDelta;
    expect(delta.messages[0].content).toBe('live text');
    expect(delta.tasks.find(item => item.id === task.id)?.activity).toMatchObject({ phase: 'responding', lastActivityAt: createdAt });
    expect(delta.runs).toEqual([]);
    expect(delta.events).toBeUndefined();
    expect(delta.cursor.eventSequence).toBe(view.cursor.eventSequence);
    expect(events).not.toHaveBeenCalled(); expect(eventsAfter).not.toHaveBeenCalled();

    s.event({ id: 'tool-next', runId: run.id, type: 'tool', data: { name: 'read_file', phase: 'started' }, createdAt });
    state.changed('content');
    const next = await core.request('state.changes', { cursor: delta.cursor, conversationId: room.id }) as SnapshotDelta;
    expect(next.events?.map(event => event.id)).toEqual(['tool-next']);
    expect(next.cursor.eventSequence).toBeGreaterThan(delta.cursor.eventSequence!);
    expect(events).not.toHaveBeenCalled(); expect(eventsAfter).toHaveBeenCalledOnce();
  });

  it('resets old, foreign, deletion and restore cursors and rereads loaded ranges authoritatively', () => {
    const { state, s, room } = stateFixture();
    for (let i = 0; i < 75; i++) s.appendMessage(message(`old${i}`, room.id));
    state.changed(); const start = state.sync.view(room.id);
    const range = state.sync.view(room.id, 1);
    expect(range.snapshot.messages).toHaveLength(75);
    s.deleteMessage('old0'); state.changed('content');
    expect(state.sync.delta(start.cursor, room.id).reset).toBe(true);
    expect(state.sync.view(room.id, 1).snapshot.messages).toHaveLength(74);
    const fresh = state.sync.cursor();
    s.invalidateTables(); state.changed('content');
    expect(state.sync.delta(fresh, room.id).reset).toBe(true);
    expect(state.sync.cursor().epoch).not.toBe(fresh.epoch);
    expect(state.sync.delta({ ...fresh, epoch: 'different' }, room.id).reset).toBe(true);
    for (let i = 0; i < 260; i++) state.changed('content');
    expect(state.sync.delta(start.cursor, room.id).reset).toBe(true);
  });

  it('preserves unread drafts below the read cursor, including unmerged replace-to-empty', async () => {
    const { core } = await setup(async () => ({ text: '' }));
    const s = core.state.storage, room = core.state.snapshot().conversations[0];
    const draft = s.appendMessage(message('draft', room.id, { status: 'draft', runId: 'run', content: '' }));
    s.appendMessage(message('seen', room.id));
    s.appendMessage(message('whitespace', room.id, { status: 'interrupted', content: '\n\t\u3000' }));
    await core.request('conversations.read', { id: room.id, messageIds: ['seen'] });
    s.messageStream.append({ id: 'a', runId: 'run', type: 'text', data: { delta: 'hello' }, createdAt: '' }, draft.id);
    expect(core.state.sync.view(room.id).snapshot.conversations).toEqual(core.state.snapshot().conversations);
    s.messageStream.append({ id: 'b', runId: 'run', type: 'text', data: { replace: '' }, createdAt: '' }, draft.id);
    expect(core.state.sync.view(room.id).snapshot.conversations.find(item => item.id === room.id)?.unreadCount).toBe(0);
    const result = await core.request('messages.get', { ids: [draft.id, 'missing'] }) as Message[];
    expect(result.map(item => item.content)).toEqual(['']);
    const page = await core.request('conversations.messages', { id: room.id, limit: 1 }) as MessagePage;
    expect(page.messages.map(item => item.id)).toEqual(['whitespace']);
    const view = await core.request('state.view', { conversationId: room.id }) as SnapshotView;
    expect(view.snapshot.bots.find(item => item.id === core.state.settings().mainBotId)?.instructions).toBe('');
  });

  it('appends non-text events by cursor, skips duplicate event changes, and avoids scanning run_events on text deltas', () => {
    const { state, s, room } = stateFixture();
    for (let i = 1; i <= 210; i++) {
      s.event({ id: `tool-${i}`, runId: 'run', type: 'tool', data: { name: 'read_file', status: 'completed' }, createdAt: `2026-10-16T00:00:${String(i).padStart(3, '0')}Z` });
    }
    s.event({ id: 'text-0', runId: 'run', type: 'text', data: { delta: 'chunk' }, createdAt: '2026-10-16T00:05:00Z' });
    state.changed('content');
    expect(s.event({ id: 'tool-210', runId: 'run', type: 'tool', data: { name: 'read_file', status: 'completed' }, createdAt: '2026-10-16T00:00:210Z' })).toBe(false);
    expect(s.changes.take().entities.size).toBe(0);

    const initial = state.sync.view(room.id);
    expect(initial.snapshot.events).toHaveLength(200);
    expect(initial.snapshot.events[0].id).toBe('tool-11');
    expect(initial.snapshot.events.at(-1)?.id).toBe('tool-210');
    expect(initial.cursor.eventSequence).toBeGreaterThan(0);

    const eventsSpy = vi.spyOn(s, 'events');
    const eventsAfterSpy = vi.spyOn(s, 'eventsAfter');
    s.event({ id: 'text-1', runId: 'run', type: 'text', data: { delta: 'more' }, createdAt: '2026-10-16T00:06:00Z' });
    state.changed('content');
    const textDelta = state.sync.delta(initial.cursor, room.id);
    expect(textDelta.reset).toBeUndefined();
    expect(textDelta.events).toBeUndefined();
    expect(textDelta.cursor.eventSequence).toBe(initial.cursor.eventSequence);
    expect(eventsSpy).not.toHaveBeenCalled();
    expect(eventsAfterSpy).not.toHaveBeenCalled();

    s.event({ id: 'tool-211', runId: 'run', type: 'tool', data: { name: 'write_file', status: 'started' }, createdAt: '2026-10-16T00:07:00Z' });
    s.event({ id: 'text-2', runId: 'run', type: 'text', data: { delta: 'tail' }, createdAt: '2026-10-16T00:07:01Z' });
    s.event({ id: 'tool-212', runId: 'run', type: 'tool', data: { name: 'write_file', status: 'completed' }, createdAt: '2026-10-16T00:07:02Z' });
    state.changed('content');
    const toolDelta = state.sync.delta(textDelta.cursor, room.id);
    expect(toolDelta.events?.map(item => item.id)).toEqual(['tool-211', 'tool-212']);
    expect(toolDelta.cursor.eventSequence).toBeGreaterThan(textDelta.cursor.eventSequence!);
    expect(eventsSpy).not.toHaveBeenCalled();
    expect(eventsAfterSpy).toHaveBeenCalledTimes(1);

    const legacyDelta = state.sync.delta({ epoch: initial.cursor.epoch, version: textDelta.cursor.version }, room.id);
    expect(legacyDelta.events).toHaveLength(200);
    expect(legacyDelta.events?.at(-1)?.id).toBe('tool-212');
    expect(legacyDelta.cursor.eventSequence).toBe(toolDelta.cursor.eventSequence);
  });
});
