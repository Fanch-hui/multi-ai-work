import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredCatalogUrl } from '../src/core/market/catalog.js';
import defaultMarketConfig from '../resources/market-config.json' with { type: 'json' };

const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
  else Reflect.deleteProperty(process, 'resourcesPath');
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('official market source', () => {
  it('uses the official default in development and when packaged configuration is absent', () => {
    vi.stubEnv('MULTI_AI_MARKET_CATALOG_URL', '');
    Object.defineProperty(process, 'resourcesPath', { value: undefined, configurable: true });
    expect(configuredCatalogUrl()).toBe(defaultMarketConfig.catalogUrl);
    const directory = mkdtempSync(join(tmpdir(), 'market-source-')); directories.push(directory);
    Object.defineProperty(process, 'resourcesPath', { value: directory, configurable: true });
    expect(configuredCatalogUrl()).toBe(defaultMarketConfig.catalogUrl);
  });

  it('prefers runtime overrides over packaged configuration and packaged configuration over the default', () => {
    vi.stubEnv('MULTI_AI_MARKET_CATALOG_URL', '');
    const directory = mkdtempSync(join(tmpdir(), 'market-source-')); directories.push(directory);
    writeFileSync(join(directory, 'market-config.json'), JSON.stringify({ catalogUrl: 'https://distribution.test/catalog.json' }));
    Object.defineProperty(process, 'resourcesPath', { value: directory, configurable: true });
    expect(configuredCatalogUrl()).toBe('https://distribution.test/catalog.json');
    vi.stubEnv('MULTI_AI_MARKET_CATALOG_URL', 'https://override.test/catalog.json');
    expect(configuredCatalogUrl()).toBe('https://override.test/catalog.json');
  });
});
