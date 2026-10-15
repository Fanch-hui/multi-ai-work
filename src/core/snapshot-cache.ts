import type { Storage } from './storage.js';

export type SnapshotTable = 'connections' | 'bots' | 'workspaces' | 'skills' | 'tool_connections';

interface CachedRows { version: number; rows: unknown[]; }

export class SnapshotCache {
  private readonly tables = new Map<SnapshotTable, CachedRows>();
  constructor(private readonly storage: Storage) {}

  all<T>(table: SnapshotTable): T[] {
    if (this.storage.db.inTransaction) {
      // Transaction-local rows must never survive a rollback in the projection cache.
      this.tables.clear();
      return this.storage.all<T>(table);
    }
    const version = this.storage.tableVersion(table);
    let cached = this.tables.get(table);
    if (!cached || cached.version !== version) {
      cached = { version, rows: this.storage.all<T>(table) };
      this.tables.set(table, cached);
    }
    return structuredClone(cached.rows) as T[];
  }
}
