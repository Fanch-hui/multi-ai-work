import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, RunEvent } from '../src/domain/types.js';
import { Storage } from '../src/core/storage.js';
import { emptyRunMetrics, migrateRunMetrics, recordRunEvent } from '../src/core/run-metrics.js';

const directories: string[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'run-metrics-')); directories.push(directory);
  return new Storage(join(directory, 'team.sqlite'));
}
const run = (id: string) => ({ id, taskId: 'task', botId: 'bot', bindingId: 'binding', status: 'failed', configRevision: 1, createdAt: '1' }) as Run;
const event = (id: string, runId: string, type: RunEvent['type'], data: RunEvent['data'] = {}) => ({ id, runId, type, data, createdAt: id });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('persisted run records', () => {
  it('pages every non-text event of one run despite other runs and the global window', () => {
    const storage = database();
    try {
      for (let i = 0; i < 450; i++) {
        storage.event(event(`a-${i}`, 'a', 'tool', { step: i }));
        storage.event(event(`b-${i}`, 'b', 'status'));
        storage.event(event(`text-${i}`, 'a', 'text'));
      }
      expect(storage.events()).toHaveLength(200);
      let cursor: number | undefined;
      const events: RunEvent[] = [];
      do {
        const page = storage.runEvents('a', cursor);
        expect(page.events.every(item => item.runId === 'a' && item.type !== 'text')).toBe(true);
        events.unshift(...page.events); cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(events.map(item => item.id)).toEqual(Array.from({ length: 450 }, (_, i) => `a-${i}`));
      expect(storage.runEvents('missing')).toEqual({ events: [], nextCursor: undefined });
    } finally { storage.close(); }
  });

  it('migrates historical metrics from complete records once and preserves partial usage', () => {
    const storage = database();
    try {
      storage.put('runs', { ...run('a'), modelDurationMs: 999 }); storage.put('runs', run('b'));
      storage.event(event('request-1', 'a', 'status', { phase: 'model-request', step: 1 }));
      storage.event(event('request-1-repeat', 'a', 'status', { phase: 'model-request', step: 1 }));
      storage.event(event('request-2', 'a', 'status', { phase: 'model-request', step: 2 }));
      storage.event(event('response', 'a', 'status', { phase: 'model-response', durationMs: 120 }));
      storage.event(event('error', 'a', 'status', { phase: 'model-error', durationMs: 80 }));
      storage.event(event('retry', 'a', 'status', { phase: 'model-retry', delayMs: 2000 }));
      storage.event(event('context', 'a', 'context', { estimatedTokens: 50, source: 'app-estimated' }));
      storage.event(event('usage', 'a', 'usage', { inputTokens: 50, outputTokens: 5, source: 'reported' }));
      storage.event(event('compaction', 'a', 'usage', { inputTokens: 999, outputTokens: 999, source: 'reported', phase: 'compaction' }));
      storage.event(event('unknown', 'a', 'usage', { source: 'unknown' }));
      for (let i = 0; i < 250; i++) storage.event(event(`other-${i}`, 'b', 'tool'));
      migrateRunMetrics(storage);
      expect(storage.get<Run>('runs', 'a')).toMatchObject({ modelRequestCount: 2, modelDurationMs: 200,
        contextUsage: { estimatedTokens: 50 }, confirmedUsage: { inputTokens: 50, outputTokens: 5, source: 'reported' } });
      expect(storage.get<Run>('runs', 'a')?.usage).toBeUndefined();
      expect(storage.get<Run>('runs', 'a')?.metrics).toBeUndefined();
      storage.put('runs', { ...storage.get<Run>('runs', 'a')!, modelRequestCount: 10 });
      migrateRunMetrics(storage);
      expect(storage.get<Run>('runs', 'a')?.modelRequestCount).toBe(10);
    } finally { storage.close(); }
  });

  it('records events and updates metrics atomically without duplicating requests', () => {
    const storage = database();
    try {
      storage.put('runs', run('a'));
      const request = event('request', 'a', 'status', { phase: 'model-request', step: 1 });
      recordRunEvent(storage, request); recordRunEvent(storage, request);
      recordRunEvent(storage, event('request-2', 'a', 'status', { phase: 'model-request', step: 2 }));
      recordRunEvent(storage, event('context', 'a', 'context', { usedPercentage: 20, source: 'native-reported' }));
      recordRunEvent(storage, event('usage', 'a', 'usage', { inputTokens: 20, outputTokens: 2, source: 'reported' }));
      recordRunEvent(storage, event('response', 'a', 'status', { phase: 'model-response', durationMs: 120 }));
      recordRunEvent(storage, event('error', 'a', 'status', { phase: 'model-error', durationMs: 80 }));
      recordRunEvent(storage, event('retry', 'a', 'status', { phase: 'model-retry', delayMs: 2000 }));
      expect(storage.runEvents('a').events).toHaveLength(7);
      expect(storage.get<Run>('runs', 'a')).toMatchObject({ modelRequestCount: 2, modelDurationMs: 200, contextUsage: { usedPercentage: 20 },
        confirmedUsage: { inputTokens: 20, outputTokens: 2, source: 'reported' } });
    } finally { storage.close(); }
  });

  it('pairs usage with its request timing and retains partial cache and speed across failures and summaries', () => {
    const storage = database();
    try {
      storage.put('runs', { ...run('a'), metrics: emptyRunMetrics(), modelRequestCount: 0 });
      const request = (requestId: string, step: number, scope?: string) =>
        recordRunEvent(storage, event(`start-${requestId}`, 'a', 'status', { phase: 'model-request', requestId, step, scope }));
      const first = event('first', 'a', 'status', { phase: 'model-response', requestId: 'a:1', step: 1, durationMs: 1000,
        usage: { source: 'reported', inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 } });
      request('a:1', 1); recordRunEvent(storage, first); recordRunEvent(storage, { ...first, id: 'repeated' });
      recordRunEvent(storage, event('cache-request', 'a', 'status', { phase: 'model-cache-request', requestId: 'a:1' }));
      recordRunEvent(storage, event('cache-response', 'a', 'status', { phase: 'model-cache-response', requestId: 'a:1',
        inputTokens: 100, cachedInputTokens: 80, diagnostics: { type: 'cache_hit' } }));
      expect(storage.runEvents('a').events.some(event => event.data.phase === 'model-cache-response')).toBe(true);
      request('a:2', 2);
      recordRunEvent(storage, event('failed', 'a', 'status', { phase: 'model-error', requestId: 'a:2', step: 2, durationMs: 500 }));
      request('summary:1', 1, 'compaction');
      recordRunEvent(storage, event('summary', 'a', 'status', { phase: 'model-response', requestId: 'summary:1', step: 1,
        scope: 'compaction', durationMs: 100, usage: { source: 'reported', inputTokens: 10, outputTokens: 2 } }));
      request('a:3', 3);
      recordRunEvent(storage, event('last', 'a', 'status', { phase: 'model-response', requestId: 'a:3', step: 3, durationMs: 500,
        usage: { source: 'reported', inputTokens: 50, outputTokens: 10, cachedInputTokens: 0 } }));
      recordRunEvent(storage, event('cumulative', 'a', 'usage', { source: 'reported', inputTokens: 150, outputTokens: 30 }));
      expect(storage.get<Run>('runs', 'a')).toMatchObject({ modelRequestCount: 4, modelDurationMs: 2000,
        metrics: { requests: 4, summaryRequests: 1, usageRequests: 3,
          usage: { inputTokens: 160, outputTokens: 32, source: 'reported' },
          cache: { inputTokens: 150, cachedInputTokens: 80, requests: 2 },
          rate: { outputTokens: 30, durationMs: 1500, requests: 2, source: 'reported' } } });
      expect(storage.runEvents('a').events).toHaveLength(11);
    } finally { storage.close(); }
  });

  it('rebuilds request samples once without inventing missing historical timing', () => {
    const storage = database();
    try {
      storage.put('runs', { ...run('a'), metrics: { ...emptyRunMetrics(), requests: 99 }, modelDurationMs: 999 });
      storage.put('runs', { ...run('legacy'), inferenceDurationMs: 10000,
        inferenceUsage: { source: 'reported', outputTokens: 20 } });
      storage.event(event('start', 'a', 'status', { phase: 'model-request', requestId: 'a:1', step: 1 }));
      const response = event('response', 'a', 'status', { phase: 'model-response', requestId: 'a:1', step: 1,
        durationMs: 200, usage: { source: 'reported', inputTokens: 20, outputTokens: 4, cachedInputTokens: 0 } });
      storage.event(response); storage.event({ ...response, id: 'repeat-response' });
      migrateRunMetrics(storage);
      expect(storage.get<Run>('runs', 'a')).toMatchObject({ modelRequestCount: 1, modelDurationMs: 200,
        metrics: { requests: 1, usageRequests: 1, rate: { outputTokens: 4, durationMs: 200, requests: 1 } } });
      expect(storage.get<Run>('runs', 'legacy')?.modelDurationMs).toBeUndefined();
      expect(storage.get<Run>('runs', 'legacy')?.metrics).toBeUndefined();
      migrateRunMetrics(storage);
      expect(storage.get<Run>('runs', 'a')?.metrics?.rate?.outputTokens).toBe(4);
    } finally { storage.close(); }
  });
});
