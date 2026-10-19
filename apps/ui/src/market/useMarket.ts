import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketState } from '../../../../src/domain/market.js';
import { errorMessage, request } from '../api.js';

export function useMarket() {
  const [state, setState] = useState<MarketState>();
  const [error, setError] = useState('');
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const value = await request<MarketState>('market.list');
      if (alive.current) {
        setState(value);
        setError('');
      }
      return value;
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().then(async (value) => {
      if (!alive.current || !value?.catalogConfigured || value.refreshedAt) return;
      try {
        const catalog = await request<MarketState>('market.refresh');
        if (alive.current) setState(catalog);
      } catch (cause) {
        if (alive.current) setError(errorMessage(cause));
      }
    });
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  const downloading = state?.installations.some((item) => item.status === 'downloading');
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [downloading, refresh]);
  const run = useCallback(
    async (method: string, params?: Record<string, unknown>) => {
      setError('');
      try {
        const value = await request(method, params);
        await refresh();
        return value;
      } catch (cause) {
        setError(errorMessage(cause));
        throw cause;
      }
    },
    [refresh],
  );
  return { state, error, refresh, run };
}
