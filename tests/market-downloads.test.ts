import { afterEach, describe, expect, it } from 'vitest';
import type { PresetInstallation } from '../src/domain/market.js';
import { MarketService } from '../src/core/market/service.js';
import { configureMarketFetch } from '../src/core/market/network.js';
import { digestBytes } from '../src/core/market/package-resources.js';
import { fixtureEntries, fixturePreset, zipFixture } from './preset-package-fixture.js';
import { setup, eventually } from './core-harness.js';

const markets: MarketService[] = [];
afterEach(async () => { for (const market of markets.splice(0)) await market.quiesce(); configureMarketFetch((input, init) => fetch(input, init)); });
async function market() {
  const { core, root } = await setup(async () => ({ text: 'unused' }));
  const service = new MarketService(core.state, core.entities, 'https://market.test/catalog.json'); markets.push(service);
  return { core, root, service };
}
const bytes = zipFixture(fixtureEntries());
const published = fixturePreset({ download: { url: 'https://market.test/preset.zip', bytes: bytes.length, sha256: digestBytes(bytes) } });
const response = () => Response.json({ formatVersion: 1, presets: [published] });

describe('market download lifecycle', () => {
  it('keeps cached catalog on failure and retries invalid packages without half installations', async () => {
    const { service, core } = await market();
    let corrupt = true;
    configureMarketFetch(async url => String(url).endsWith('catalog.json') ? response() : new Response(corrupt ? 'invalid' : bytes));
    expect((await service.refresh()).presets).toHaveLength(1);
    const first = service.download(published.id);
    await eventually(() => service.list().installations[0]?.status === 'failed');
    expect(core.state.storage.all('skills').filter((skill: any) => !skill.bundled)).toHaveLength(0);
    corrupt = false; service.download(published.id);
    await eventually(() => service.list().installations[0]?.status === 'installed');
    const installed = service.list().installations[0]!;
    expect(installed.id).toBe(first.id); expect(installed.progress).toBe(100);
    expect(service.download(published.id)).toEqual(installed);
    configureMarketFetch(async () => new Response('unavailable', { status: 503 }));
    await expect(service.refresh()).rejects.toThrow('503');
    expect(service.list().presets).toHaveLength(1);
    expect(service.list().installations[0]?.status).toBe('installed');
  });

  it('cancels in-flight downloads and never registers incomplete skills', async () => {
    const { service, core } = await market();
    configureMarketFetch(async (url, init) => {
      if (String(url).endsWith('catalog.json')) return response();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    await service.refresh(); const item = service.download(published.id);
    await service.cancel(item.id);
    expect(service.list().installations[0]?.status).toBe('cancelled');
    expect(core.state.storage.all('skills').filter((skill: any) => !skill.bundled)).toHaveLength(0);
  });

  it('validates redirected protocols and profession preferences independently of team membership', async () => {
    const { service, core } = await market();
    configureMarketFetch(async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }));
    await expect(service.refresh()).rejects.toThrow('HTTPS');
    const before = core.state.snapshot().bots;
    await service.request('career.save', { professionIds: ['legal', 'student', 'legal'], status: 'completed' });
    expect(service.list().preferences).toEqual({ professionIds: ['legal', 'student'], status: 'completed' });
    expect(core.state.snapshot().bots).toEqual(before);
    await expect(service.request('career.save', { professionIds: ['missing'], status: 'completed' })).rejects.toThrow('分类不存在');
  });
});
