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

it('任务与会话绑定针对性查询命中索引，且多代不同用途绑定定位准确', () => {
  const directory = mkdtempSync(join(tmpdir(), 'binding-targeted-'));
  const file = join(directory, 'test.sqlite');
  const storage = new Storage(file);
  try {
    storage.put('tasks', { id: 't1', requestId: 'req-1', parentId: 'p-1', conversationId: 'c1', status: 'queued' });
    storage.put('tasks', { id: 't2', requestId: 'req-2', parentId: 'p-1', conversationId: 'c1', status: 'running' });

    const reqPlan = storage.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM tasks
      WHERE json_extract(payload, '$.requestId') = ? ORDER BY rowid LIMIT 1`).all('req-1');
    expect(JSON.stringify(reqPlan)).toContain('tasks_by_request');

    const parentCountPlan = storage.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM tasks
      WHERE json_extract(payload, '$.parentId') = ?`).all('p-1');
    expect(JSON.stringify(parentCountPlan)).toContain('tasks_by_parent');

    expect(storage.firstByField<{ id: string }>('tasks', 'requestId', 'req-2')?.id).toBe('t2');
    expect(storage.countByField('tasks', 'parentId', 'p-1')).toBe(2);

    const base = {
      botId: 'bot-1',
      conversationId: 'conv-1',
      connectionId: 'conn-1',
      configRevision: 1,
      connectionRevision: 1,
      workspaceId: 'ws-1',
      lastDeliveredSequence: 0,
    };
    storage.put('session_bindings', { ...base, id: 'b-conv-1', generation: 1 });
    storage.put('session_bindings', { ...base, id: 'b-conv-2', generation: 2 });
    storage.put('session_bindings', { ...base, id: 'b-mem-1', generation: 1, purpose: 'memory' });
    storage.put('session_bindings', { ...base, id: 'b-mem-4', generation: 4, purpose: 'memory' });
    storage.put('session_bindings', { ...base, id: 'b-qd-3', generation: 3, purpose: 'question-decision' });
    storage.put('session_bindings', { ...base, id: 'b-other', botId: 'bot-2', generation: 9 });

    const bindingNullPlan = storage.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM session_bindings
      WHERE json_extract(payload, '$.botId') = ? AND json_extract(payload, '$.conversationId') = ?
        AND json_extract(payload, '$.purpose') IS NULL
      ORDER BY json_extract(payload, '$.generation') DESC, rowid DESC LIMIT 1`).all('bot-1', 'conv-1');
    expect(JSON.stringify(bindingNullPlan)).toContain('bindings_by_owner_generation');

    const bindingPurposePlan = storage.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM session_bindings
      WHERE json_extract(payload, '$.botId') = ? AND json_extract(payload, '$.conversationId') = ?
        AND json_extract(payload, '$.purpose') = ?
      ORDER BY json_extract(payload, '$.generation') DESC, rowid DESC LIMIT 1`).all('bot-1', 'conv-1', 'memory');
    expect(JSON.stringify(bindingPurposePlan)).toContain('bindings_by_owner_generation');

    expect(storage.latestBinding('bot-1', 'conv-1')?.id).toBe('b-conv-2');
    expect(storage.latestBinding('bot-1', 'conv-1', 'question-decision')?.id).toBe('b-qd-3');
    expect(storage.latestBinding('bot-1', 'conv-1', 'memory')?.id).toBe('b-mem-4');
    expect(storage.latestBinding('bot-3', 'conv-1', 'question-decision')).toBeUndefined();
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
