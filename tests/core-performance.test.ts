import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../src/core/state.js';
import { Storage } from '../src/core/storage.js';
import { subscribeBatchedChanges } from '../src/core/state-notifications.js';
import type { Task } from '../src/domain/types.js';
import { setup, eventually } from './core-harness.js';

const stores: { storage: Storage; root: string }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const { storage, root } of stores.splice(0)) {
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});

describe('stream notifications and indexed task queries', () => {
  it('persists all deltas immediately while batching notifications and delivering final state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-stream-notifications-'));
    const state = new State(root);
    stores.push({ storage: state.storage, root });
    vi.useFakeTimers();
    const message = state.storage.appendMessage({
      id: 'stream',
      conversationId: 'room',
      authorType: 'bot',
      authorBotId: 'member',
      runId: 'run',
      content: '',
      artifactIds: [],
      status: 'draft',
      createdAt: new Date().toISOString(),
    });
    const received: string[] = [];
    const unsubscribe = subscribeBatchedChanges(state, () =>
      received.push(state.storage.getMessage(message.id)!.content),
    );
    for (let index = 0; index < 100; index++) {
      message.content += 'a';
      state.storage.updateMessage(message);
      state.changed('content');
    }
    expect(state.storage.getMessage(message.id)?.content).toHaveLength(100);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(80);
    expect(received).toEqual(['a'.repeat(100)]);
    message.content += '!';
    state.storage.updateMessage(message);
    state.changed('content');
    message.status = 'committed';
    state.storage.updateMessage(message);
    state.changed();
    state.changed();
    await Promise.resolve();
    expect(received).toEqual(['a'.repeat(100), `${'a'.repeat(100)}!`]);
    vi.advanceTimersByTime(80);
    expect(received).toHaveLength(2);
    state.changed();
    unsubscribe();
    await Promise.resolve();
    vi.advanceTimersByTime(80);
    expect(received).toHaveLength(2);
  });

  it('does not rescan task queues for streamed text, then finishes the real task', async () => {
    let emit!: (delta: string) => void, finish!: () => void;
    const { core, bot } = await setup(async (context) => {
      emit = (delta) => context.emit({ type: 'text', data: { delta } });
      await new Promise<void>((resolve) => {
        finish = resolve;
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { text: 'Completed' };
    });
    const member = bot('Streaming member');
    const room = core.entities.createConversation({
      name: 'Streaming',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: 'Work' });
    await eventually(() => !!emit);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const queries = vi.spyOn(core.state.storage.db, 'prepare');
    for (let index = 0; index < 100; index++) emit('a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      queries.mock.calls.filter(([sql]) => /SELECT payload FROM tasks/.test(sql)),
    ).toHaveLength(0);
    queries.mockRestore();
    finish();
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
  });

  it('adds usable indexes to an existing database without altering records or its backup version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-storage-indexes-'));
    let storage = new Storage(join(root, 'team.sqlite'));
    const records = Array.from({ length: 200 }, (_, index) => ({
      id: `task-${index}`,
      status: index === 199 ? 'queued' : 'completed',
      parentId: `parent-${index % 2}`,
    }));
    for (const record of records) storage.put('tasks', record);
    storage.put('tool_operations', { id: 'operation', runId: 'selected-run', status: 'unknown' });
    storage.db.exec(
      'DROP INDEX tasks_by_status; DROP INDEX tasks_by_parent; DROP INDEX operations_by_run;',
    );
    storage.close();
    storage = new Storage(join(root, 'team.sqlite'));
    stores.push({ storage, root });
    expect(storage.all('tasks')).toHaveLength(200);
    expect(storage.byField('tasks', 'status', 'queued')).toEqual([records[199]]);
    expect(storage.byField('tasks', 'parentId', 'parent-1')).toHaveLength(100);
    expect(storage.byField('tool_operations', 'runId', 'selected-run')).toEqual([
      { id: 'operation', runId: 'selected-run', status: 'unknown' },
    ]);
    for (const [table, field] of [
      ['tasks', 'status'],
      ['tasks', 'parentId'],
      ['tool_operations', 'runId'],
    ]) {
      const plans = storage.db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT payload FROM ${table} WHERE json_extract(payload, '$.${field}') = ?`,
        )
        .all('selected') as { detail: string }[];
      expect(plans.some((plan) => plan.detail.includes('USING INDEX'))).toBe(true);
    }
    expect(storage.db.pragma('user_version', { simple: true })).toBe(2);
  });
});
