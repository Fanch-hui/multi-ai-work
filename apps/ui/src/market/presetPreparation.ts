import type { PresetInstallation } from '../../../../src/domain/market.js';
import type { MarketRow } from './marketRows.js';

export interface PresetPreparation {
  row: MarketRow;
  status: 'preparing' | 'ready' | 'failed' | 'cancelled';
  installation?: PresetInstallation;
  error?: string;
  configured?: boolean;
}

export function preparationResult(
  row: MarketRow,
  installation: PresetInstallation | { cancelled: true } | undefined,
): PresetPreparation {
  if (!installation || 'cancelled' in installation) return { row, status: 'cancelled' };
  if (installation.status === 'installed') return { row, installation, status: 'ready' };
  if (installation.status === 'downloading') return { row, installation, status: 'preparing' };
  return {
    row,
    installation,
    status: installation.status === 'cancelled' ? 'cancelled' : 'failed',
    error: installation.error || '预设资源未就绪，请重试',
  };
}

export function reconcilePreparations(
  values: PresetPreparation[],
  installations: PresetInstallation[],
): PresetPreparation[] {
  let changed = false;
  const next = values.map((value) => {
    if (value.status !== 'preparing' || !value.installation) return value;
    const item = installations.find((entry) => entry.id === value.installation!.id);
    if (!item || item.status === 'downloading') return value;
    changed = true;
    return preparationResult(value.row, item);
  });
  return changed ? next : values;
}

export function preparationSummary(values: PresetPreparation[]) {
  return {
    ready: values.filter((item) => item.status === 'ready' && !item.configured),
    failed: values.filter((item) => item.status === 'failed'),
    cancelled: values.filter((item) => item.status === 'cancelled'),
    preparing: values.filter((item) => item.status === 'preparing'),
    configured: values.filter((item) => item.configured),
  };
}
