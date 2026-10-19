import type { State } from './state.js';

export function subscribeBatchedChanges(
  state: Pick<State, 'subscribe'>,
  notify: () => void,
  intervalMs = 80,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let urgent = false,
    closed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!closed) notify();
  };
  const unsubscribe = state.subscribe((kind) => {
    if (kind === 'state') {
      clearTimeout(timer);
      timer = undefined;
      if (urgent) return;
      urgent = true;
      // Publish after the current transaction, without waiting for the stream batch.
      queueMicrotask(() => {
        urgent = false;
        flush();
      });
      return;
    }
    if (timer || urgent) return;
    timer = setTimeout(flush, intervalMs);
  });
  return () => {
    closed = true;
    unsubscribe();
    clearTimeout(timer);
    timer = undefined;
  };
}
