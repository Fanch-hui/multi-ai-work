import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Storage } from '../src/core/storage.js';

it('升级旧库后按绑定索引读取档案，保留插入顺序', () => {
  const directory = mkdtempSync(join(tmpdir(), 'binding-index-'));
  const file = join(directory, 'test.sqlite');
  let storage = new Storage(file);
  try {
    for (const table of ['provider_archive', 'context_checkpoints'] as const) {
      storage.put(table, { id: 'z', bindingId: 'a', content: 'first' });
      storage.put(table, { id: 'other', bindingId: 'b', content: 'excluded' });
      storage.put(table, { id: 'a', bindingId: 'a', content: 'second' });
    }
    storage.db.exec('DROP INDEX archive_by_binding; DROP INDEX checkpoints_by_binding');
    storage.close(); storage = new Storage(file);
    for (const table of ['provider_archive', 'context_checkpoints'] as const) {
      expect(storage.byField<{ id: string }>(table, 'bindingId', 'a').map(row => row.id)).toEqual(['z', 'a']);
      const plan = storage.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM ${table}
        WHERE json_extract(payload, '$.bindingId') = ? ORDER BY rowid`).all('a');
      expect(JSON.stringify(plan)).toContain(table === 'provider_archive' ? 'archive_by_binding' : 'checkpoints_by_binding');
    }
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
