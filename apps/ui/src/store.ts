import { useCallback, useEffect, useRef, useState } from 'react';
import { request, subscribe } from './api.js';
import { TeamSnapshotStore, type TeamView } from './snapshot-store.js';

export function useTeamStore() {
  const [view, setView] = useState<TeamView>({ error: '', loadingHistory: false });
  const mounted = useRef(true);
  const store = useRef<TeamSnapshotStore | undefined>(undefined);
  if (!store.current)
    store.current = new TeamSnapshotStore(request, (value) => {
      if (mounted.current) setView(value);
    });
  const refresh = useCallback(() => store.current!.refresh(true), []);
  const selectConversation = useCallback((id?: string) => store.current!.select(id), []);
  const loadMore = useCallback(() => store.current!.loadMore(), []);
  useEffect(() => {
    mounted.current = true;
    // Subscribe before reading the first cursor so changes during startup are queued.
    const close = subscribe(() => void store.current!.refresh());
    void refresh();
    return () => {
      mounted.current = false;
      close();
    };
  }, [refresh]);
  const mutate = useCallback(async <T>(method: string, params?: Record<string, unknown>) => {
    const result = await request<T>(method, params);
    await store.current!.refresh();
    return result;
  }, []);
  return { ...view, refresh, mutate, selectConversation, loadMore };
}
export type Mutate = ReturnType<typeof useTeamStore>['mutate'];
export interface ConversationHistory {
  hasMore: boolean;
  loading: boolean;
  loadMore: () => Promise<void>;
}
