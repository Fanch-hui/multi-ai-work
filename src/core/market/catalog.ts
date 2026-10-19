import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPreset, CareerPreferences, PresetCatalog } from '../../domain/market.js';
import { professions } from '../../domain/market.js';
import type { State } from '../state.js';
import { now } from '../state.js';
import { z } from 'zod';
import { catalogSchema } from './schema.js';
import { fetchMarketBytes, marketUrl } from './network.js';
import defaultMarketConfig from '../../../resources/market-config.json' with { type: 'json' };

export function configuredCatalogUrl(): string | undefined {
  if (process.env.MULTI_AI_MARKET_CATALOG_URL)
    return marketUrl(process.env.MULTI_AI_MARKET_CATALOG_URL);
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources)
    try {
      const config = JSON.parse(readFileSync(join(resources, 'market-config.json'), 'utf8')) as {
        catalogUrl?: string;
      };
      if (config.catalogUrl) return marketUrl(config.catalogUrl);
    } catch {}
  return marketUrl(defaultMarketConfig.catalogUrl);
}

// Only accepted, distributable releases belong in the public catalog.
const builtinCatalog: AgentPreset[] = [];
export class MarketCatalog {
  constructor(
    private state: State,
    readonly url = configuredCatalogUrl(),
  ) {}
  list(): AgentPreset[] {
    const cached = this.state.storage.metadata<PresetCatalog>('market.catalog');
    return cached?.presets ?? builtinCatalog;
  }
  preferences(): CareerPreferences {
    return (
      this.state.storage.metadata<CareerPreferences>('market.career') ?? {
        professionIds: [],
        status: 'pending',
      }
    );
  }
  savePreferences(input: unknown): CareerPreferences {
    const value = z
      .object({
        professionIds: z.array(z.string()).max(professions.length),
        status: z.enum(['completed', 'skipped']),
      })
      .parse(input);
    if (value.professionIds.some((id) => !professions.some((item) => item.id === id)))
      throw new Error('职业分类不存在');
    const preferences = { ...value, professionIds: [...new Set(value.professionIds)] };
    this.state.storage.setMetadata('market.career', preferences);
    this.state.changed();
    return preferences;
  }
  async refresh(signal?: AbortSignal) {
    if (!this.url) throw new Error('尚未配置官方市场下载源，可以先导入本地预设包');
    const bytes = await fetchMarketBytes(this.url, { maximum: 4 * 1024 * 1024, signal });
    const catalog = catalogSchema.parse(JSON.parse(bytes.toString('utf8'))) as PresetCatalog;
    for (const preset of catalog.presets) {
      if (!preset.download) throw new Error('官方目录缺少资源包下载信息');
      marketUrl(preset.download.url);
      if (preset.professions.some((id) => !professions.some((item) => item.id === id)))
        throw new Error('目录包含未知职业分类');
    }
    const keys = catalog.presets.map((item) => item.id);
    if (new Set(keys).size !== keys.length) throw new Error('官方目录包含重复的预设');
    this.state.storage.transaction(() => {
      this.state.storage.setMetadata('market.catalog', catalog);
      this.state.storage.setMetadata('market.refreshedAt', now());
    });
    this.state.changed();
    return catalog;
  }
}
