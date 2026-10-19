import { stat } from 'node:fs/promises';
import { readAntigravityCatalog, type AntigravityModel } from './antigravity-catalog.js';

interface Entry {
  models: AntigravityModel[];
  modified: number;
  expires: number;
}
interface Pending {
  controller: AbortController;
  result: Promise<AntigravityModel[]>;
  waiters: number;
  settled: boolean;
}

export class AntigravityCatalogCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  async read(
    executable: string,
    revision: number,
    cwd: string,
    signal: AbortSignal,
    refresh = false,
  ) {
    signal.throwIfAborted();
    const key = JSON.stringify([executable, revision]),
      modified = (await stat(executable)).mtimeMs;
    signal.throwIfAborted();
    const entry = this.entries.get(key);
    if (!refresh && entry && entry.modified === modified && entry.expires > Date.now())
      return entry.models;
    const pendingKey = JSON.stringify([executable, revision, modified]);
    let operation = this.pending.get(pendingKey);
    if (!operation) {
      const controller = new AbortController();
      const current: Pending = {
        controller,
        waiters: 0,
        settled: false,
        result: readAntigravityCatalog(executable, cwd, controller.signal)
          .then((models) => {
            controller.signal.throwIfAborted();
            this.entries.set(key, { models, modified, expires: Date.now() + 5 * 60_000 });
            return models;
          })
          .finally(() => {
            current.settled = true;
            if (this.pending.get(pendingKey) === current) this.pending.delete(pendingKey);
          }),
      };
      operation = current;
      this.pending.set(pendingKey, current);
    }
    return this.wait(pendingKey, operation, signal);
  }

  private wait(key: string, operation: Pending, signal: AbortSignal): Promise<AntigravityModel[]> {
    operation.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener('abort', cancel);
        if (--operation.waiters === 0 && !operation.settled) {
          if (this.pending.get(key) === operation) this.pending.delete(key);
          operation.controller.abort(signal.reason);
        }
        return true;
      };
      const cancel = () => {
        if (finish()) reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      operation.result.then(
        (models) => {
          if (finish()) resolve(models);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
      if (signal.aborted) cancel();
    });
  }
}
