import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, request, subscribe } from '../api.js';

export function useResource<T>(
  method: string,
  params: Record<string, unknown> = {},
  enabled = true,
) {
  const key = JSON.stringify(params);
  const identity = `${method}:${key}`;
  const reloadCurrent = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadCurrent.current(), []);
  const [state, setState] = useState<{ key: string; value?: T; error: string; loading: boolean }>({
    key: '',
    value: undefined,
    error: '',
    loading: enabled,
  });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    let running = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (!current) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      setState((value) => ({
        ...value,
        key: identity,
        value: value.key === identity ? value.value : undefined,
        loading: true,
      }));
      try {
        const value = await request<T>(method, JSON.parse(key));
        if (current) setState({ key: identity, value, error: '', loading: false });
      } catch (cause) {
        if (current)
          setState((value) => ({ ...value, error: errorMessage(cause), loading: false }));
      } finally {
        running = false;
        if (pending && current) {
          pending = false;
          schedule();
        }
      }
    }
    function schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, 200);
    }
    reloadCurrent.current = () => void read();
    const close = subscribe(schedule);
    void read();
    return () => {
      current = false;
      reloadCurrent.current = () => {};
      close();
      if (timer) clearTimeout(timer);
    };
  }, [method, key, identity, enabled]);
  const current = enabled && state.key === identity;
  return {
    value: current ? state.value : undefined,
    error: current ? state.error : '',
    loading: enabled && (!current || state.loading),
    reload,
  };
}
