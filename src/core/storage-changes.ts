export interface StorageChanges {
  reset: boolean;
  invalidated?: boolean;
  entities: Map<string, Set<string>>;
}

export class StorageChangesBuffer {
  private changes: StorageChanges = { reset: false, entities: new Map() };
  ids(table: string): string[] {
    return [...(this.changes.entities.get(table) ?? [])];
  }
  mark(table: string, id: string) {
    if (this.changes.reset) return;
    const ids = this.changes.entities.get(table) ?? new Set<string>();
    ids.add(id);
    this.changes.entities.set(table, ids);
    if (ids.size > 2048) this.reset();
  }
  reset(invalidated = false) {
    this.changes = {
      reset: true,
      invalidated: invalidated || this.changes.invalidated,
      entities: new Map(),
    };
  }
  take(): StorageChanges {
    const result = this.changes;
    this.changes = { reset: false, entities: new Map() };
    return result;
  }
}
