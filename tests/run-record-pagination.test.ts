import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, RunEvent, RunEventPage } from '../src/domain/types.js';
import type { ReactElement } from 'react';
import { RunRecords } from '../apps/ui/src/RunRecords.js';
import { useRunRecords } from '../apps/ui/src/use-run-records.js';

const state = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        index: number;
        values: unknown[];
        effects: { deps: unknown[]; cleanup?: () => void }[];
        pending: (() => void)[];
      },
  requests: [] as {
    params: Record<string, unknown>;
    resolve(page: RunEventPage): void;
    reject(error: Error): void;
  }[],
}));
vi.mock('../apps/ui/src/api.js', () => ({
  request: (_method: string, params: Record<string, unknown>) =>
    new Promise<RunEventPage>((resolve, reject) =>
      state.requests.push({ params, resolve, reject }),
    ),
  errorMessage: (error: Error) => error.message,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: <T>(initial: T | (() => T)) => {
    const hooks = state.current!;
    const index = hooks.index++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      hooks.values[index],
      (value: T | ((old: T) => T)) => {
        hooks.values[index] =
          typeof value === 'function' ? (value as (old: T) => T)(hooks.values[index] as T) : value;
      },
    ];
  },
  useRef: <T>(initial: T) => {
    const hooks = state.current!;
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const hooks = state.current!;
    const index = hooks.index++;
    const previous = hooks.effects[index];
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      hooks.effects[index] = { deps, cleanup: cleanup || undefined };
    });
  },
}));
const run: Run = {
  id: 'run',
  taskId: 'task',
  botId: 'member',
  bindingId: 'binding',
  status: 'running',
  configRevision: 1,
  createdAt: '2026-10-22',
};
const event = (id: string): RunEvent => ({
  id,
  runId: run.id,
  type: 'tool',
  data: { callId: id, status: 'completed' },
  createdAt: id,
});
function fixture(view?: 'work') {
  const hooks = {
    index: 0,
    values: [] as unknown[],
    effects: [] as { deps: unknown[]; cleanup?: () => void }[],
    pending: [] as (() => void)[],
  };
  return {
    render(open = true, latestId = 'initial', status = run.status) {
      state.current = hooks;
      hooks.index = 0;
      const result = useRunRecords({ ...run, status }, open, latestId, view);
      for (const effect of hooks.pending.splice(0)) effect();
      return result;
    },
    unmount() {
      for (const effect of hooks.effects) effect?.cleanup?.();
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  state.requests = [];
});
describe('independent run record pagination', () => {
  it('follows the latest run by default and preserves an explicit open choice', () => {
    const hooks = {
      index: 0,
      values: [] as unknown[],
      effects: [] as { deps: unknown[]; cleanup?: () => void }[],
      pending: [] as (() => void)[],
    };
    const task = { id: run.taskId, runIds: [run.id] } as import('../src/domain/types.js').Task;
    const render = (defaultOpen: boolean) => {
      state.current = hooks;
      hooks.index = 0;
      const tree = RunRecords({ run, task, recent: [], defaultOpen }) as ReactElement<{
        open: boolean;
        onToggle(event: { currentTarget: { open: boolean } }): void;
      }>;
      for (const effect of hooks.pending.splice(0)) effect();
      return tree;
    };
    let tree = render(true);
    expect(tree.props.open).toBe(true);
    tree.props.onToggle({ currentTarget: { open: true } });
    tree = render(false);
    expect(tree.props.open).toBe(false);
    tree.props.onToggle({ currentTarget: { open: true } });
    expect(render(false).props.open).toBe(true);
    expect(render(true).props.open).toBe(true);
    for (const effect of hooks.effects) effect?.cleanup?.();
  });

  it('loads work and diagnostics on demand with separate cursors and caches', async () => {
    const work = fixture('work');
    const diagnostic = fixture();
    work.render(false);
    diagnostic.render(false);
    expect(state.requests).toHaveLength(0);
    work.render();
    expect(state.requests[0].params).toEqual({ id: run.id, view: 'work' });
    state.requests[0].resolve({ events: [event('work')], nextCursor: 100 });
    await flush();
    diagnostic.render();
    expect(state.requests[1].params).toEqual({ id: run.id });
    state.requests[1].resolve({ events: [event('diagnostic')], nextCursor: 200 });
    await flush();
    const earlier = work.render().earlier();
    expect(state.requests[2].params).toEqual({ id: run.id, view: 'work', cursor: 100 });
    state.requests[2].resolve({ events: [event('old-work')], nextCursor: 50 });
    await earlier;
    expect(work.render().events.map((item) => item.id)).toEqual(['old-work', 'work']);
    expect(work.render().cursor).toBe(50);
    expect(diagnostic.render().events.map((item) => item.id)).toEqual(['diagnostic']);
    expect(diagnostic.render().cursor).toBe(200);
  });

  it('keeps a new history gap reachable when an older page finishes after realtime refresh', async () => {
    const work = fixture('work');
    work.render();
    state.requests[0].resolve({ events: [event('10')], nextCursor: 9 });
    await flush();
    const oldPage = work.render().earlier();
    work.render(true, '100', 'completed');
    state.requests[2].resolve({ events: [event('100')], nextCursor: 99 });
    await flush();
    expect(work.render(true, '100', 'completed').busy).toBe(true);
    state.requests[1].resolve({ events: [event('09')], nextCursor: 8 });
    await oldPage;
    const result = work.render(true, '100', 'completed');
    expect(result.cursor).toBe(99);
    expect(result.events.map((item) => item.id)).toEqual(['09', '10', '100']);
    expect(result.busy).toBe(false);
    const gap = result.earlier();
    expect(state.requests[3].params.cursor).toBe(99);
    state.requests[3].resolve({ events: [event('50')], nextCursor: 49 });
    await gap;
    expect(work.render(true, '100', 'completed').cursor).toBe(49);
  });

  it('ignores a superseded latest response and retains the cursor after a failed older page', async () => {
    const work = fixture('work');
    work.render();
    work.render(true, 'new');
    state.requests[1].resolve({ events: [event('new')], nextCursor: 20 });
    await flush();
    state.requests[0].resolve({ events: [event('stale')], nextCursor: 5 });
    await flush();
    expect(work.render(true, 'new').events.map((item) => item.id)).toEqual(['new']);
    const earlier = work.render(true, 'new').earlier();
    state.requests[2].reject(new Error('读取失败'));
    await earlier;
    const result = work.render(true, 'new');
    expect(result.cursor).toBe(20);
    expect(result.error).toBe('读取失败');
    const retry = result.earlier();
    state.requests[3].resolve({ events: [event('old')] });
    await retry;
    expect(work.render(true, 'new').error).toBe('');
    work.unmount();
  });
});
