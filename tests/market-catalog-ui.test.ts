import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketState, PresetInstallation } from '../src/domain/market.js';
import type { Snapshot } from '../src/domain/types.js';
import { Market } from '../apps/ui/src/Market.js';

const market = vi.hoisted(() => ({
  state: undefined as MarketState | undefined,
  status: 'loading' as 'loading' | 'success' | 'error',
  catalogError: '',
}));
vi.mock('../apps/ui/src/market/useMarket.js', () => ({
  useMarket: () => ({
    ...market,
    operationError: '',
    refresh: vi.fn(),
    retry: vi.fn(),
    run: vi.fn(),
  }),
}));

const installation: PresetInstallation = {
  id: 'local-reviewer',
  source: 'local',
  status: 'installed',
  progress: 100,
  skillIds: [],
  createdAt: '',
  preset: {
    id: 'reviewer',
    version: '1',
    name: '文稿评审员',
    role: '评审',
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
const emptyCatalog: MarketState = {
  professions: [],
  presets: [],
  installations: [],
  preferences: { status: 'pending', professionIds: [] },
  catalogConfigured: true,
};

function markup() {
  return renderToStaticMarkup(
    createElement(Market, {
      data: { bots: [] } as unknown as Snapshot,
      mutate: async () => undefined as never,
      configureConnection: () => {},
    }),
  );
}

beforeEach(() => {
  market.state = { ...emptyCatalog };
  market.status = 'loading';
  market.catalogError = '';
});

describe('market catalog loading view', () => {
  it('keeps the loading view after an empty local list while the first catalog is pending', () => {
    const html = markup();
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('暂时没有匹配的预设');
    expect(html).toContain('已下载');
    expect(html).toContain('导入预设');
  });

  it('shows an empty result once the initial catalog finishes', () => {
    market.state = { ...emptyCatalog, refreshedAt: 'now' };
    market.status = 'success';
    expect(markup()).toContain('暂时没有匹配的预设');
    market.status = 'loading';
    const refreshing = markup();
    expect(refreshing).toContain('暂时没有匹配的预设');
    expect(refreshing).not.toContain('aria-busy="true"');
  });

  it('keeps available catalog entries and local imports visible during a refresh', () => {
    for (const fields of [{ presets: [installation.preset] }, { installations: [installation] }]) {
      market.state = { ...emptyCatalog, ...fields };
      const html = markup();
      expect(html).toContain(installation.preset.name);
      expect(html).toContain('雇佣');
      expect(html).not.toContain('aria-busy="true"');
    }
  });

  it('shows retry and local import actions after the first catalog fails', () => {
    market.status = 'error';
    market.catalogError = '目录暂时不可用';
    const html = markup();
    expect(html).toContain(market.catalogError);
    expect(html).toContain('重新读取目录');
    expect(html).toContain('导入预设');
    expect(html).not.toContain('aria-busy="true"');
  });
});
