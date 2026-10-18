import { describe, expect, it, vi } from 'vitest';
import { Storage } from '../src/core/storage.js';

describe('visible event queries', () => {
  it('uses the visible sequence index across a long text history and preserves event cursors', () => {
    const storage = new Storage(':memory:');
    try {
      const event = (id: string, type: 'text' | 'tool') => storage.event({ id, runId: 'run', type, data: {}, createdAt: '2026-10-18' });
      event('before', 'tool');
      const before = storage.latestNonTextEventSequence();
      storage.transaction(() => { for (let i = 0; i < 5000; i++) event(`text-${i}`, 'text'); });
      event('after', 'tool');
      const prepare = vi.spyOn(storage, 'prepare');
      expect(storage.events().map(item => item.id)).toEqual(['before', 'after']);
      const page = storage.eventsAfter(before);
      expect(page.events.map(item => item.id)).toEqual(['after']);
      expect(storage.latestNonTextEventSequence()).toBe(page.eventSequence);
      expect(storage.eventsAfter(page.eventSequence)).toEqual({ events: [], eventSequence: page.eventSequence });
      const queries = [...new Set(prepare.mock.calls.map(([sql]) => sql))];
      expect(queries).toHaveLength(3);
      for (const sql of queries) {
        const parameters = Array.from(sql.matchAll(/\?/g), () => 1);
        const plan = storage.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
        expect(plan.some(row => row.detail.includes('INDEX visible_events_by_sequence'))).toBe(true);
        expect(plan.some(row => row.detail.includes('SCAN run_events') || row.detail.includes('TEMP B-TREE'))).toBe(false);
      }
    } finally { storage.close(); }
  });
});
