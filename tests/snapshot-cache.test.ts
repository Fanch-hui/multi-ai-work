import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '../src/domain/types.js';
import { SnapshotCache, type SnapshotTable } from '../src/core/snapshot-cache.js';
import { State } from '../src/core/state.js';
import { Storage } from '../src/core/storage.js';

const resources: { directory: string; storage: Storage }[] = [];
const tables: SnapshotTable[] = ['connections', 'bots', 'workspaces', 'skills', 'tool_connections'];
function temporaryStorage() {
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-cache-'));
  const storage = new Storage(join(directory, 'test.sqlite'));
  resources.push({ directory, storage });
  return storage;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { directory, storage } of resources.splice(0)) {
    storage.close(); rmSync(directory, { recursive: true, force: true });
  }
});

describe('快照配置投影缓存', () => {
  it('只在对应配置表修改后重新读取，返回对象互不共享', () => {
    const storage = temporaryStorage(), cache = new SnapshotCache(storage);
    for (const table of tables) storage.put(table, { id: 'one', nested: { value: 'original' } });
    const read = vi.spyOn(storage, 'all');
    for (const table of tables) {
      const rows = cache.all<{ id: string; nested: { value: string } }>(table);
      rows[0].nested.value = 'mutated'; rows.pop();
      expect(cache.all(table)).toEqual([{ id: 'one', nested: { value: 'original' } }]);
    }
    expect(read).toHaveBeenCalledTimes(5);
    storage.put('connections', { id: 'one', nested: { value: 'updated' } });
    expect(cache.all('connections')).toEqual([{ id: 'one', nested: { value: 'updated' } }]);
    cache.all('bots'); expect(read).toHaveBeenCalledTimes(6);
    storage.delete('connections', 'one');
    expect(cache.all('connections')).toEqual([]);
    expect(read).toHaveBeenCalledTimes(7);
    expect(storage.all('bots')).toEqual([{ id: 'one', nested: { value: 'original' } }]);
  });

  it('事务中直接读取，提交后刷新，回滚不泄漏未提交数据', () => {
    const storage = temporaryStorage(), cache = new SnapshotCache(storage);
    storage.put('connections', { id: 'one', name: 'initial' });
    expect(cache.all('connections')).toEqual([{ id: 'one', name: 'initial' }]);
    storage.transaction(() => {
      storage.put('connections', { id: 'one', name: 'committed' });
      expect(cache.all('connections')).toEqual([{ id: 'one', name: 'committed' }]);
    });
    expect(cache.all('connections')).toEqual([{ id: 'one', name: 'committed' }]);
    expect(() => storage.transaction(() => {
      storage.put('connections', { id: 'one', name: 'rolled back' });
      expect(cache.all('connections')).toEqual([{ id: 'one', name: 'rolled back' }]);
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(cache.all('connections')).toEqual([{ id: 'one', name: 'committed' }]);
    expect(() => storage.transaction(() => {
      storage.delete('connections', 'one');
      throw new Error('rollback without snapshot');
    })).toThrow('rollback without snapshot');
    expect(cache.all('connections')).toEqual([{ id: 'one', name: 'committed' }]);
  });

  it('批量 SQL 恢复后失效全部配置，失败回滚后仍读取已提交状态', () => {
    const storage = temporaryStorage(), cache = new SnapshotCache(storage);
    for (const table of tables) {
      storage.put(table, { id: 'old', name: 'initial' });
      cache.all(table);
    }
    const restore = (fail = false) => {
      try {
        storage.transaction(() => {
          for (const table of tables) {
            storage.db.exec(`DELETE FROM ${table}`);
            storage.db.prepare(`INSERT INTO ${table}(id,payload) VALUES (?,?)`)
              .run('restored', JSON.stringify({ id: 'restored', name: fail ? 'uncommitted' : 'restored' }));
          }
          if (fail) throw new Error('restore failed');
        });
      } finally { storage.invalidateTables(); }
    };
    restore();
    for (const table of tables) expect(cache.all(table)).toEqual([{ id: 'restored', name: 'restored' }]);
    expect(() => restore(true)).toThrow('restore failed');
    for (const table of tables) expect(cache.all(table)).toEqual([{ id: 'restored', name: 'restored' }]);
  });

  it('连续快照复用五类配置读取，保留主管过滤与实时消息', () => {
    const directory = mkdtempSync(join(tmpdir(), 'snapshot-state-'));
    const state = new State(directory), storage = state.storage;
    resources.push({ directory, storage });
    const chiefId = state.settings().mainBotId!;
    const chief = storage.get<Bot>('bots', chiefId)!;
    storage.put('bots', { ...chief, id: 'member', instructions: 'member instructions', role: 'member' });
    const read = vi.spyOn(storage, 'all');
    for (let index = 0; index < 20; index++) {
      const snapshot = state.snapshot();
      expect(snapshot.bots.find(bot => bot.id === chiefId)).toMatchObject({ role: '', instructions: '' });
      expect(snapshot.bots.find(bot => bot.id === 'member')?.instructions).toBe('member instructions');
      snapshot.bots.find(bot => bot.id === 'member')!.toolNames.push('mutation');
      snapshot.workspaces[0].name = 'mutation';
    }
    const cachedReads = read.mock.calls.filter(([table]) => tables.includes(table as SnapshotTable));
    expect(cachedReads).toHaveLength(5); // The uncached projection requires 100 reads for this load.
    expect(storage.get<Bot>('bots', chiefId)?.instructions).toBe(chief.instructions);
    const snapshot = state.snapshot();
    expect(snapshot.bots.find(bot => bot.id === 'member')?.toolNames).not.toContain('mutation');
    expect(snapshot.workspaces[0].name).not.toBe('mutation');
    const roomId = state.settings().mainConversationId!;
    storage.appendMessage({ id: 'live', conversationId: roomId, authorType: 'user',
      content: 'live message', artifactIds: [], status: 'committed', createdAt: new Date().toISOString() });
    expect(state.snapshot().messages.find(message => message.id === 'live')?.content).toBe('live message');
  });
});
