import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../../../src/domain/types.js";
import { errorMessage, request, snapshot, subscribe } from "./api.js";
export function useTeamStore() {
  const [data, setData] = useState<Snapshot>();
  const [error, setError] = useState("");
  const refreshing = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (refreshing.current) {
      queued.current = true;
      return;
    }
    refreshing.current = true;
    try {
      const value = await snapshot();
      if (mounted.current) {
        setData(value);
        setError("");
      }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      refreshing.current = false;
      if (queued.current) {
        queued.current = false;
        void refresh();
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const close = subscribe(() => void refresh());
    return () => {
      mounted.current = false;
      close();
    };
  }, [refresh]);
  const mutate = useCallback(
    async <T>(method: string, params?: Record<string, unknown>) => {
      const result = await request<T>(method, params);
      await refresh();
      return result;
    },
    [refresh],
  );
  return { data, error, refresh, mutate };
}
export type Mutate = ReturnType<typeof useTeamStore>["mutate"];
