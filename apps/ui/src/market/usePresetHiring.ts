import { useEffect, useRef, useState } from 'react';
import type { PresetInstallation } from '../../../../src/domain/market.js';
import type { MarketRow } from './marketRows.js';

export function usePresetHiring(
  installations: PresetInstallation[],
  run: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  configure: (items: PresetInstallation[]) => void,
) {
  const [pending, setPending] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    if (!pending.length) return;
    const items = pending.map((id) => installations.find((item) => item.id === id));
    if (items.some((item) => !item || item.status === 'downloading')) return;
    const ready = items.filter((item): item is PresetInstallation => item?.status === 'installed');
    setPending([]);
    locked.current = false;
    if (ready.length) configure(ready);
  }, [pending, installations, configure]);
  async function hire(rows: MarketRow[]) {
    if (locked.current || !rows.length) return;
    locked.current = true;
    setStarting(true);
    const results = await Promise.allSettled(
      rows.map(async (row) =>
        row.installation?.status === 'installed'
          ? row.installation
          : ((await run(
              row.source === 'local' ? 'market.import' : 'market.download',
              row.source === 'local' ? undefined : { presetId: row.preset.id },
            )) as PresetInstallation | undefined),
      ),
    );
    const ids = results.flatMap((item) =>
      item.status === 'fulfilled' && item.value ? [item.value.id] : [],
    );
    setPending([...new Set(ids)]);
    setStarting(false);
    if (!ids.length) locked.current = false;
  }
  return { hire, hiring: starting || pending.length > 0 };
}
