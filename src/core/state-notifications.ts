import type { State } from './state.js';

export function subscribeBatchedChanges(state: Pick<State, 'subscribe'>, notify: () => void, intervalMs = 80): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = state.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; notify(); }, intervalMs);
  });
  return () => { unsubscribe(); clearTimeout(timer); timer = undefined; };
}
