import { stat } from 'node:fs/promises';
import { readAntigravityCatalog, type AntigravityModel } from './antigravity-catalog.js';

interface Entry { models: AntigravityModel[]; modified: number; expires: number; }

export class AntigravityCatalogCache {
  private entries = new Map<string, Entry>();
  async read(executable: string, revision: number, cwd: string, signal: AbortSignal, refresh = false) {
    const key = `${executable}:${revision}`, modified = (await stat(executable)).mtimeMs;
    const entry = this.entries.get(key);
    if (!refresh && entry && entry.modified === modified && entry.expires > Date.now()) return entry.models;
    const models = await readAntigravityCatalog(executable, cwd, signal);
    this.entries.set(key, { models, modified, expires: Date.now() + 5 * 60_000 });
    return models;
  }
}
