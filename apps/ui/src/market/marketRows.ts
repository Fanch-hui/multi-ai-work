import type {
  AgentPreset,
  MarketState,
  PresetInstallation,
} from '../../../../src/domain/market.js';
import type { Bot } from '../../../../src/domain/types.js';
export interface MarketRow {
  key: string;
  preset: AgentPreset;
  source: 'official' | 'local';
  installation?: PresetInstallation;
}
export function marketRows(state: MarketState | undefined, downloaded: boolean): MarketRow[] {
  if (!state) return [];
  if (downloaded)
    return state.installations.map((installation) => ({
      key: installation.id,
      preset: installation.preset,
      source: installation.source,
      installation,
    }));
  const rows: MarketRow[] = state.presets.map((preset) => ({
    key: `official:${preset.id}`,
    preset,
    source: 'official',
    installation: state.installations.find(
      (item) =>
        item.source === 'official' &&
        item.preset.id === preset.id &&
        item.preset.version === preset.version,
    ),
  }));
  const local = new Map<string, PresetInstallation>();
  for (const item of state.installations
    .filter((item) => item.source === 'local')
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    local.set(item.preset.id, item);
  rows.push(
    ...[...local.values()].map((installation) => ({
      key: installation.id,
      preset: installation.preset,
      source: 'local' as const,
      installation,
    })),
  );
  return rows;
}
export function rowMembers(row: MarketRow, bots: Bot[]): Bot[] {
  return bots.filter(
    (bot) => bot.preset?.presetId === row.preset.id && bot.preset.source === row.source,
  );
}
