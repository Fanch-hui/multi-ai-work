import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketState } from '../../../../src/domain/market.js';
import { errorMessage, request } from '../api.js';

export function useMarket() {
  const [state, setState] = useState<MarketState>();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [catalogError, setCatalogError] = useState('');
  const [listError, setListError] = useState('');
  const [operationError, setOperationError] = useState('');
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const value = await request<MarketState>('market.list');
      if (alive.current) {
        setState(value);
        setListError('');
        setStatus('success');
      }
      return value;
    } catch (cause) {
      if (alive.current) {
        setListError(errorMessage(cause));
        setStatus('error');
      }
    }
  }, []);
  const refreshCatalog = useCallback(async () => {
    setStatus('loading');
    setCatalogError('');
    try {
      const value = await request<MarketState>('market.refresh');
      if (alive.current) {
        setState(value);
        setListError('');
        setStatus('success');
      }
      return value;
    } catch (cause) {
      if (alive.current) {
        setCatalogError(errorMessage(cause));
        setStatus('error');
      }
      throw cause;
    }
  }, []);
  const retry = useCallback(async () => {
    setStatus('loading');
    const value = await refresh();
    if (!alive.current || !value) return;
    if (!value.catalogConfigured) {
      setCatalogError('');
      return;
    }
    try {
      await refreshCatalog();
    } catch {
      // The catalog error is displayed while retaining the last successful list.
    }
  }, [refresh, refreshCatalog]);
  useEffect(() => {
    alive.current = true;
    async function loadInitialCatalog() {
      const value = await refresh();
      if (!alive.current || !value?.catalogConfigured || value.refreshedAt) return;
      try {
        await refreshCatalog();
      } catch {
        // Initial failure leaves local installations available for use.
      }
    }
    void loadInitialCatalog();
    return () => {
      alive.current = false;
    };
  }, [refresh, refreshCatalog]);
  const downloading = state?.installations.some((item) => item.status === 'downloading');
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [downloading, refresh]);
  const run = useCallback(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === 'market.refresh') return refreshCatalog();
      setOperationError('');
      try {
        const value = await request(method, params);
        await refresh();
        return value;
      } catch (cause) {
        if (alive.current) setOperationError(errorMessage(cause));
        throw cause;
      }
    },
    [refresh, refreshCatalog],
  );
  return {
    state,
    status,
    catalogError: catalogError || listError,
    operationError,
    error: catalogError || listError,
    refresh,
    retry,
    run,
  };
}
