import { describe, expect, it, vi } from 'vitest';
import type { Message, Snapshot } from '../src/domain/types.js';
import type { SnapshotDelta, SnapshotView } from '../src/domain/snapshot-sync.js';
import { TeamSnapshotStore } from '../apps/ui/src/snapshot-store.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const message = (id: string, sequence: number, content = id): Message => ({
  id,
  sequence,
  content,
  conversationId: 'room',
  authorType: 'bot',
  artifactIds: [],
  status: 'committed',
  createdAt: '',
});
const snapshot = (messages: Message[] = []): Snapshot =>
  ({
    messages,
    tasks: [],
    runs: [],
    processes: [],
    conversations: [],
    events: [],
  }) as unknown as Snapshot;
const view = (messages: Message[] = [], version = 1, epoch = 'epoch'): SnapshotView => ({
  snapshot: snapshot(messages),
  cursor: { epoch, version },
  history: { conversationId: 'room', nextBefore: messages[0]?.sequence },
});
const delta = (messages: Message[] = [], version = 2): SnapshotDelta => ({
  cursor: { epoch: 'epoch', version },
  messages,
  tasks: [],
  runs: [],
  processes: [],
});
function fixture(handler: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const request = vi.fn(handler);
  const publish = vi.fn();
  const store = new TeamSnapshotStore(
    request as <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
    publish,
  );
  return { store, request, publish };
}

describe('UI snapshot synchronization', () => {
  it('advances an empty delta cursor without publishing or changing loaded references', async () => {
    let version = 1;
    const { store, request, publish } = fixture(async (method) =>
      method === 'state.view' ? view([message('one', 1)]) : delta([], ++version),
    );
    await store.refresh(true);
    const initial = store.current();
    Object.freeze(initial.data!.messages);
    await store.refresh();
    expect(store.current()).toBe(initial);
    expect(publish).toHaveBeenCalledTimes(1);
    await store.refresh();
    expect(request.mock.calls.at(-1)?.[1]?.cursor).toEqual({ epoch: 'epoch', version: 2 });
    expect(store.current()).toBe(initial);
  });

  it('clears a synchronization error when the next delta has no visible updates', async () => {
    let failing = true;
    const { store, publish } = fixture(async (method) => {
      if (method === 'state.view') return view([message('one', 1)]);
      if (failing) throw new Error('temporarily unavailable');
      return delta();
    });
    await store.refresh(true);
    const initial = store.current().data;
    await store.refresh();
    expect(store.current().error).toBe('temporarily unavailable');
    failing = false;
    await store.refresh();
    expect(store.current().error).toBe('');
    expect(store.current().data).toBe(initial);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('orders messages at ingestion and preserves untouched objects during streamed edits', async () => {
    const first = message('first', 1),
      second = message('second', 2);
    const received = [second, first];
    let version = 1;
    const { store } = fixture(async (method) => {
      if (method === 'state.view') return view(received);
      version++;
      return version === 2
        ? delta([message('second', 2, 'streaming')])
        : delta([message('second', 4, 'published'), message('third', 3)], version);
    });
    await store.refresh(true);
    expect(received).toEqual([second, first]);
    expect(store.current().data?.messages).toEqual([first, second]);
    await store.refresh();
    expect(store.current().data?.messages.map((item) => item.id)).toEqual(['first', 'second']);
    expect(store.current().data?.messages[0]).toBe(first);
    expect(store.current().data?.messages[1]).not.toBe(second);
    await store.refresh();
    expect(store.current().data?.messages.map((item) => item.id)).toEqual([
      'first',
      'third',
      'second',
    ]);
    expect(store.current().data?.messages[0]).toBe(first);
  });

  it('publishes completed task and reply updates while the authoritative reload is still pending', async () => {
    const running = { id: 'task', status: 'running' },
      completed = { ...running, status: 'completed' };
    const draft = { ...message('reply', 1), status: 'draft' as const };
    const committed = { ...draft, status: 'committed' as const };
    const reload = deferred<SnapshotView>();
    let reads = 0;
    const initial: SnapshotView = {
      ...view([draft]),
      snapshot: { ...snapshot([draft]), tasks: [running] as Snapshot['tasks'] },
    };
    const final: SnapshotView = {
      ...view([committed], 2),
      snapshot: { ...snapshot([committed]), tasks: [completed] as Snapshot['tasks'] },
    };
    const { store } = fixture(async (method) => {
      if (method === 'state.view') return ++reads === 1 ? initial : reload.promise;
      return { ...delta([committed]), tasks: [completed], reset: true };
    });
    await store.refresh(true);
    const pending = store.refresh();
    await vi.waitFor(() => expect(store.current().data?.tasks[0].status).toBe('completed'));
    expect(store.current().data?.messages[0].status).toBe('committed');
    expect(reads).toBe(2);
    reload.resolve(final);
    await pending;
    expect(store.current().data).toEqual(final.snapshot);
  });

  it('queues notifications during the initial read and upserts full messages without duplicated chunks', async () => {
    const initial = deferred<SnapshotView>();
    const { store, request } = fixture(async (method) =>
      method === 'state.view' ? initial.promise : delta([message('one', 1, 'finished')]),
    );
    const pending = store.refresh(true);
    void store.refresh();
    initial.resolve(view([message('one', 1, 'partial')]));
    await pending;
    expect(request.mock.calls.map(([method]) => method)).toEqual(['state.view', 'state.changes']);
    expect(store.current().data?.messages).toEqual([message('one', 1, 'finished')]);
  });

  it('discards earlier responses on conversation switch and fetches the selected room', async () => {
    const old = deferred<SnapshotView>();
    const { store, request } = fixture(async (_method, params) =>
      params?.conversationId === 'new' ? view([message('new', 1)]) : old.promise,
    );
    const pending = store.refresh(true);
    store.select('new');
    old.resolve(view([message('old', 1)]));
    await pending;
    expect(store.current().data?.messages.map((item) => item.id)).toEqual(['new']);
    expect(request.mock.calls.at(-1)?.[1]?.conversationId).toBe('new');
  });

  it('merges older pages without overwriting newer live messages and preserves the loaded range on refresh', async () => {
    const page = deferred<{ messages: Message[]; nextBefore?: number }>();
    let fullCount = 0;
    const { store, request } = fixture(async (method) => {
      if (method === 'state.view')
        return ++fullCount === 1
          ? view([message('middle', 51)])
          : view([message('first', 1), message('middle', 51, 'latest')]);
      if (method === 'conversations.messages') return page.promise;
      return delta([message('middle', 51, 'latest'), message('last', 52)]);
    });
    store.select('room');
    await store.refresh();
    const loading = store.loadMore();
    await store.refresh();
    page.resolve({ messages: [message('first', 1), message('middle', 51, 'stale')] });
    await loading;
    expect(store.current().data?.messages.map((item) => item.content)).toEqual([
      'first',
      'latest',
      'last',
    ]);
    await store.refresh(true);
    expect(request.mock.calls.at(-1)?.[1]?.from).toBe(1);
    expect(store.current().data?.messages.map((item) => item.id)).toEqual(['first', 'middle']);
  });

  it('discards a page response after reset and does not reuse an old dataset range after restart or restore', async () => {
    const page = deferred<{ messages: Message[] }>();
    let fullCount = 0;
    const { store, request } = fixture(async (method) => {
      if (method === 'state.view')
        return ++fullCount === 1
          ? view([message('old', 99)])
          : view([message('restored', 1)], 3, 'restored');
      if (method === 'conversations.messages') return page.promise;
      return { ...delta(), reset: true, cursor: { epoch: 'restored', version: 3 } };
    });
    store.select('room');
    await vi.waitFor(() => expect(store.current().data?.messages[0]?.id).toBe('old'));
    const loading = store.loadMore();
    await store.refresh();
    page.resolve({ messages: [message('stale', 1)] });
    await loading;
    expect(store.current().data?.messages.map((item) => item.id)).toEqual(['restored']);
    const calls = request.mock.calls.filter(([method]) => method === 'state.view');
    expect(calls.at(-1)?.[1]?.from).toBeUndefined();
  });

  it('replaces events on full view and idempotently appends up to 200 events on delta updates', async () => {
    const makeEvent = (id: string, createdAt = id) => ({
      id,
      runId: 'run',
      type: 'tool' as const,
      data: { status: createdAt },
      createdAt,
    });
    const initialEvents = Array.from({ length: 199 }, (_, i) => makeEvent(`e${i + 1}`));
    let step = 0;
    const { store } = fixture(async (method) => {
      if (method === 'state.view') {
        return {
          snapshot: {
            ...snapshot([message('m1', 1)]),
            events: step === 0 ? initialEvents : [makeEvent('reset-event')],
          },
          cursor: {
            epoch: 'epoch',
            version: step === 0 ? 1 : 5,
            eventSequence: step === 0 ? 199 : 205,
          },
        };
      }
      step++;
      if (step === 1)
        return {
          ...delta([message('m1', 1, 'stream-1')], 2),
          cursor: { epoch: 'epoch', version: 2, eventSequence: 199 },
        };
      if (step === 2)
        return {
          ...delta([], 3),
          cursor: { epoch: 'epoch', version: 3, eventSequence: 202 },
          events: [makeEvent('e199', 'updated'), makeEvent('e200'), makeEvent('e201')],
        };
      return {
        ...delta([], 4),
        reset: true,
        cursor: { epoch: 'epoch', version: 4, eventSequence: 202 },
      };
    });

    await store.refresh(true);
    expect(store.current().data?.events).toHaveLength(199);

    await store.refresh();
    expect(store.current().data?.events).toHaveLength(199);

    await store.refresh();
    const merged = store.current().data?.events ?? [];
    expect(merged).toHaveLength(200);
    expect(merged[0]?.id).toBe('e2');
    expect(merged.find((item) => item.id === 'e199')?.data.status).toBe('updated');
    expect(merged.slice(-2).map((item) => item.id)).toEqual(['e200', 'e201']);

    await store.refresh();
    expect(store.current().data?.events.map((item) => item.id)).toEqual(['reset-event']);
  });
});
