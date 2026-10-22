import { useCallback, useEffect, useRef, useState } from 'react';
import type { PresetInstallation } from '../../../../src/domain/market.js';
import { errorMessage } from '../api.js';
import type { MarketRow } from './marketRows.js';
import {
  preparationResult,
  preparationSummary,
  reconcilePreparations,
  type PresetPreparation,
} from './presetPreparation.js';

export function usePresetHiring(
  installations: PresetInstallation[],
  run: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  configure: (items: PresetInstallation[]) => void,
) {
  const [results, setResults] = useState<PresetPreparation[]>([]);
  const [starting, setStarting] = useState(false);
  const locked = useRef(false);
  const configuredKeys = useRef(new Set<string>());
  const summary = preparationSummary(results);
  const configureReady = useCallback(() => {
    const ready = results.filter(
      (item) => item.status === 'ready' && !configuredKeys.current.has(item.row.key),
    );
    if (!ready.length) return;
    for (const item of ready) configuredKeys.current.add(item.row.key);
    setResults((values) =>
      values.map((item) => (ready.includes(item) ? { ...item, configured: true } : item)),
    );
    configure(ready.map((item) => item.installation!));
  }, [results, configure]);
  useEffect(() => {
    if (starting) return;
    const next = reconcilePreparations(results, installations);
    if (next !== results) {
      setResults(next);
      return;
    }
    if (summary.preparing.length) return;
    locked.current = false;
    if (!summary.failed.length && !summary.cancelled.length) configureReady();
  }, [
    results,
    starting,
    installations,
    summary.preparing.length,
    summary.failed.length,
    summary.cancelled.length,
    configureReady,
  ]);
  async function prepare(rows: MarketRow[], retrying: boolean) {
    if (locked.current || !rows.length) return;
    locked.current = true;
    setStarting(true);
    if (!retrying) configuredKeys.current.clear();
    const pending = rows.map((row): PresetPreparation => ({ row, status: 'preparing' }));
    setResults((values) =>
      retrying
        ? values.map((item) => pending.find((next) => next.row.key === item.row.key) || item)
        : pending,
    );
    await Promise.all(
      rows.map(async (row) => {
        let result: PresetPreparation;
        try {
          const installed = installations.find(
            (item) =>
              item.source === row.source &&
              item.preset.id === row.preset.id &&
              item.preset.version === row.preset.version &&
              item.status === 'installed',
          );
          const item =
            installed ||
            ((await run(
              row.source === 'local' ? 'market.import' : 'market.download',
              row.source === 'local' ? undefined : { presetId: row.preset.id },
            )) as PresetInstallation | { cancelled: true } | undefined);
          result = preparationResult(row, item);
        } catch (cause) {
          result = { row, status: 'failed', error: errorMessage(cause) };
        }
        setResults((values) => values.map((item) => (item.row.key === row.key ? result : item)));
      }),
    );
    setStarting(false);
  }
  return {
    hire: (rows: MarketRow[]) => prepare(rows, false),
    retry: () =>
      prepare(
        [...summary.failed, ...summary.cancelled].map((item) => item.row),
        true,
      ),
    configureReady,
    dismiss: () => setResults([]),
    results,
    hiring: starting || summary.preparing.length > 0,
  };
}
