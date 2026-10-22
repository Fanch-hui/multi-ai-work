import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketState, PresetInstallation } from '../src/domain/market.js';
import type { MarketRow } from '../apps/ui/src/market/marketRows.js';
import { useMarket } from '../apps/ui/src/market/useMarket.js';
import { usePresetHiring } from '../apps/ui/src/market/usePresetHiring.js';
import { CatalogLoadState } from '../apps/ui/src/market/CatalogLoadState.js';
import { HiringPreparation } from '../apps/ui/src/market/HiringPreparation.js';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  cleanups: [] as (() => void)[],
}));
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../apps/ui/src/api.js', () => ({
  request: api.request,
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  const slot = <T>(initial: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values))
      hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      hooks.values[index] as T,
      (next: T | ((value: T) => T)) => {
        hooks.values[index] =
          typeof next === 'function' ? (next as (value: T) => T)(hooks.values[index] as T) : next;
      },
    ] as const;
  };
  const changed = (previous: unknown[] | undefined, next: unknown[]) =>
    !previous || next.some((value, index) => value !== previous[index]);
  return {
    ...react,
    useState: slot,
    useRef: <T>(value: T) => slot(() => ({ current: value }))[0],
    useCallback: <T>(value: T, deps: unknown[]) => {
      const [previous, save] = slot<{ value: T; deps: unknown[] } | undefined>(undefined);
      if (previous && !changed(previous.deps, deps)) return previous.value;
      save({ value, deps });
      return value;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const [previous, save] = slot<unknown[] | undefined>(undefined);
      if (!changed(previous, deps)) return;
      save(deps);
      hooks.effects.push(() => {
        const cleanup = effect();
        if (cleanup) hooks.cleanups.push(cleanup);
      });
    },
  };
});

function render<T>(hook: () => T): T {
  hooks.cursor = 0;
  const value = hook();
  for (const effect of hooks.effects.splice(0)) effect();
  return value;
}
async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function installation(
  id: string,
  status: PresetInstallation['status'] = 'installed',
): PresetInstallation {
  return {
    id,
    source: 'official',
    status,
    progress: 100,
    skillIds: [],
    createdAt: '',
    preset: {
      id,
      version: '1',
      name: id,
      role: 'reviewer',
      description: '',
      professions: [],
      rank: 1,
      instructions: '',
      examples: [],
      outputs: [],
      skills: [],
      dependencies: [],
      platforms: ['darwin'],
      license: 'MIT',
      releaseNotes: '',
    },
  };
}
function row(id: string): MarketRow {
  return { key: `official:${id}`, source: 'official', preset: installation(id).preset };
}
const catalog: MarketState = {
  professions: [],
  presets: [installation('first').preset],
  installations: [],
  preferences: { status: 'pending', professionIds: [] },
  catalogConfigured: true,
  refreshedAt: 'now',
};

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.cleanups = [];
  api.request.mockReset();
});
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup();
});

describe('market load feedback', () => {
  it('ends the initial skeleton on failure and retries to a usable catalog', async () => {
    api.request.mockRejectedValueOnce(new Error('Core unavailable'));
    expect(render(useMarket).status).toBe('loading');
    await settle();
    let view = render(useMarket);
    expect(view.status).toBe('error');
    expect(view.catalogError).toBe('Core unavailable');
    const html = renderToStaticMarkup(
      createElement(CatalogLoadState, {
        loading: false,
        error: view.catalogError,
        retry: () => {},
        importPreset: () => {},
      }),
    );
    expect(html).toContain('重试');
    expect(html).toContain('导入预设');
    expect(html).not.toContain('aria-busy');
    api.request.mockResolvedValue(catalog);
    await view.retry();
    view = render(useMarket);
    expect(view.status).toBe('success');
    expect(view.catalogError).toBe('');
    expect(view.state).toEqual(catalog);
  });

  it('clears a failed list request after a successful catalog refresh', async () => {
    api.request.mockRejectedValueOnce(new Error('List unavailable'));
    render(useMarket);
    await settle();
    let view = render(useMarket);
    expect(view.catalogError).toBe('List unavailable');
    api.request.mockResolvedValueOnce(catalog);
    await view.run('market.refresh');
    view = render(useMarket);
    expect(view.status).toBe('success');
    expect(view.catalogError).toBe('');
    expect(view.state).toEqual(catalog);
  });

  it('finishes initial catalog refresh errors while retaining locally available resources', async () => {
    api.request.mockResolvedValueOnce({ ...catalog, refreshedAt: undefined });
    api.request.mockRejectedValueOnce(new Error('Catalog offline'));
    render(useMarket);
    await settle();
    const view = render(useMarket);
    expect(view.status).toBe('error');
    expect(view.state?.presets).toEqual(catalog.presets);
    expect(view.catalogError).toBe('Catalog offline');
    expect(view.operationError).toBe('');
  });

  it('retains the catalog and separates refresh failures from operation errors', async () => {
    api.request.mockResolvedValueOnce(catalog);
    render(useMarket);
    await settle();
    let view = render(useMarket);
    api.request.mockRejectedValueOnce(new Error('Catalog offline'));
    await expect(view.run('market.refresh')).rejects.toThrow('Catalog offline');
    view = render(useMarket);
    api.request.mockRejectedValueOnce(new Error('Bad archive'));
    await expect(view.run('market.import')).rejects.toThrow('Bad archive');
    view = render(useMarket);
    expect(view.state).toEqual(catalog);
    expect(view.catalogError).toBe('Catalog offline');
    expect(view.operationError).toBe('Bad archive');
    api.request.mockResolvedValueOnce(catalog);
    await view.refresh();
    expect(render(useMarket).catalogError).toBe('Catalog offline');
  });
});

describe('batch preset preparation', () => {
  it('keeps per-preset failures and configures each successful preparation once across retry', async () => {
    let installations: PresetInstallation[] = [];
    const configure = vi.fn();
    const run = vi.fn(async (_method, params) => {
      if (params?.presetId === 'second') throw new Error('Download failed');
      return installation('first');
    });
    const hook = () => usePresetHiring(installations, run, configure);
    await render(hook).hire([row('first'), row('second')]);
    let view = render(hook);
    expect(configure).not.toHaveBeenCalled();
    expect(view.results.map((item) => item.status)).toEqual(['ready', 'failed']);
    const html = renderToStaticMarkup(
      createElement(HiringPreparation, {
        results: view.results,
        busy: view.hiring,
        retry: () => {},
        configure: () => {},
        dismiss: () => {},
      }),
    );
    expect(html).toContain('就绪 1 位，失败 1 位');
    expect(html).toContain('配置就绪的 1 位成员');
    view.configureReady();
    view.configureReady();
    expect(configure).toHaveBeenCalledTimes(1);
    view = render(hook);
    run.mockResolvedValue(installation('second'));
    await view.retry();
    render(hook);
    render(hook);
    expect(run.mock.calls.map((call) => call[1]?.presetId)).toEqual(['first', 'second', 'second']);
    expect(
      configure.mock.calls.map((call) => call[0].map((item: PresetInstallation) => item.id)),
    ).toEqual([['first'], ['second']]);
    installations = [installation('first'), installation('second')];
    render(hook);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('records a cancelled local file picker and retries only that preset', async () => {
    const configure = vi.fn();
    const run = vi.fn(async (): Promise<unknown> => ({ cancelled: true }));
    const hook = () => usePresetHiring([], run, configure);
    const localRow: MarketRow = { ...row('local'), source: 'local' };
    await render(hook).hire([localRow]);
    let view = render(hook);
    expect(view.results).toMatchObject([{ row: localRow, status: 'cancelled' }]);
    expect(view.results[0].error).toBeUndefined();
    expect(view.hiring).toBe(false);
    expect(configure).not.toHaveBeenCalled();
    run.mockResolvedValueOnce({ ...installation('local'), source: 'local' });
    await view.retry();
    render(hook);
    view = render(hook);
    expect(run).toHaveBeenNthCalledWith(1, 'market.import', undefined);
    expect(run).toHaveBeenNthCalledWith(2, 'market.import', undefined);
    expect(configure).toHaveBeenCalledOnce();
    expect(view.results[0].status).toBe('ready');
  });

  it('waits for downloads and preserves cancellation separately from successful resources', async () => {
    let installations = [
      installation('first', 'downloading'),
      installation('second', 'downloading'),
    ];
    const configure = vi.fn();
    const run = vi.fn(async (_method, params) =>
      installations.find((item) => item.id === params?.presetId),
    );
    const hook = () => usePresetHiring(installations, run, configure);
    await render(hook).hire([row('first'), row('second')]);
    expect(render(hook).hiring).toBe(true);
    installations = [installation('first'), installation('second', 'cancelled')];
    render(hook);
    let view = render(hook);
    expect(view.hiring).toBe(false);
    expect(view.results.map((item) => item.status)).toEqual(['ready', 'cancelled']);
    expect(configure).not.toHaveBeenCalled();
    run.mockResolvedValue(installation('second'));
    await view.retry();
    render(hook);
    view = render(hook);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0][0].map((item: PresetInstallation) => item.id)).toEqual([
      'first',
      'second',
    ]);
    expect(view.results.every((item) => item.configured)).toBe(true);
  });
});
