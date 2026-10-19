import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Conversation, Run, RunEvent, Snapshot, Task } from '../src/domain/types.js';
import { conversationStatistics } from '../apps/ui/src/conversation-statistics.js';
import { ConversationStats } from '../apps/ui/src/ConversationStats.js';
import { StatisticsDetails } from '../apps/ui/src/StatisticsDetails.js';

const conversation = { id: 'room' } as Conversation;
const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, conversationId: 'room', runIds: [], ...extra }) as Task;
const run = (id: string, taskId: string, createdAt: string, extra: Partial<Run> = {}) =>
  ({ id, taskId, createdAt, status: 'completed', ...extra }) as Run;
const event = (
  runId: string,
  type: RunEvent['type'],
  data: RunEvent['data'],
  createdAt = '2026-10-12T00:00:00Z',
) => ({ runId, type, data, createdAt }) as RunEvent;
const snapshot = (tasks: Task[], runs: Run[], events: RunEvent[] = []) =>
  ({ tasks, runs, events }) as Pick<Snapshot, 'tasks' | 'runs' | 'events'>;

describe('conversation statistics', () => {
  it('counts the full session, excludes background memory and other conversations, and selects latest run by time', () => {
    const data = snapshot(
      [
        task('a'),
        task('b'),
        task('child', { parentId: 'a' }),
        task('memory', { kind: 'memory-review' }),
        task('decision', { kind: 'question-decision' }),
        task('other', { conversationId: 'other' }),
      ],
      [
        run('latest', 'b', '2026-10-12T02:00:00Z'),
        run('old', 'a', '2026-10-12T01:00:00Z'),
        run('continued', 'a', '2026-10-12T01:30:00Z'),
        run('child', 'child', '2026-10-12T01:45:00Z'),
        run('memory', 'memory', '2026-10-12T04:00:00Z'),
        run('decision', 'decision', '2026-10-12T04:30:00Z'),
        run('other', 'other', '2026-10-12T05:00:00Z'),
      ],
      [
        event('old', 'status', { phase: 'model-request', step: 1 }),
        event('old', 'status', { phase: 'model-request', step: 1 }),
        event('old', 'status', { phase: 'model-request', step: 2 }),
        event('latest', 'status', { phase: 'model-request', step: 1 }),
      ],
    );
    const stats = conversationStatistics(data, conversation);
    expect(stats.latestRun?.id).toBe('latest');
    expect(stats.turns).toBe(2);
    expect(stats.runs).toBe(4);
    expect(stats.knownRequests).toBe(3);
    expect(stats.unknownRequestRuns).toBe(4);
    expect(stats.requests).toBe(3);
    expect(stats.requestsComplete).toBe(false);
  });

  it('sums input and output without double counting cache and distinguishes missing cache from reported zero', () => {
    const data = snapshot(
      [task('a')],
      [
        run('a', 'a', '1', {
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, source: 'reported' },
        }),
      ],
    );
    expect(conversationStatistics(data, conversation).usage).toMatchObject({
      total: 120,
      cachePercent: 0,
      complete: true,
    });
    data.runs.push(
      run('b', 'a', '2', { usage: { inputTokens: 100, outputTokens: 20, source: 'reported' } }),
    );
    const stats = conversationStatistics(data, conversation);
    expect(stats.usage.total).toBe(240);
    expect(stats.usage.cachePercent).toBe(0);
    expect(stats.usage.cached).toBe(0);
    expect(stats.usage).toMatchObject({
      cacheInput: 100,
      cacheLegacyRuns: 1,
      cacheLegacyTotalRuns: 2,
      cacheComplete: false,
    });
  });

  it('labels partial and estimated use instead of treating missing or unknown records as zero', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', { usage: { inputTokens: 10, outputTokens: 2, source: 'estimated' } }),
          run('b', 'a', '2'),
          run('c', 'a', '3', { usage: { inputTokens: 100, outputTokens: 20, source: 'unknown' } }),
        ],
      ),
      conversation,
    );
    expect(stats.usage).toMatchObject({
      total: 12,
      estimated: true,
      complete: false,
      missingRuns: 2,
    });
    expect(stats.usage.cachePercent).toBeUndefined();
    const empty = conversationStatistics(snapshot([], []), conversation);
    expect(empty.usage.total).toBeUndefined();
    expect(empty.context.percent).toBeUndefined();
  });

  it('uses current cumulative usage event once, without mixing compaction samples or older usage samples', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [run('a', 'a', '1', { status: 'running' })],
        [
          event(
            'a',
            'usage',
            { inputTokens: 500, outputTokens: 500, source: 'reported', phase: 'compaction' },
            '3',
          ),
          event('a', 'usage', { inputTokens: 10, outputTokens: 1, source: 'reported' }, '1'),
          event('a', 'usage', { inputTokens: 20, outputTokens: 2, source: 'reported' }, '2'),
        ],
      ),
      conversation,
    );
    expect(stats.usage.total).toBe(22);
  });

  it('keeps persisted request and context summaries when the recent event window is empty', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', {
            modelRequestCount: 30,
            contextUsage: { source: 'app-estimated', estimatedTokens: 25, contextWindow: 100 },
            usage: { inputTokens: 100, outputTokens: 10, source: 'reported' },
          }),
        ],
      ),
      conversation,
    );
    expect(stats.requests).toBe(30);
    expect(stats.requestsComplete).toBe(false);
    expect(stats.summaryUnknownRuns).toBe(1);
    expect(stats.context.percent).toBe(25);
    expect(stats.usage).toMatchObject({ total: 110, complete: true, completeRuns: 1 });
  });

  it('shows confirmed usage of failed requests without calling it a complete total', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', {
            status: 'failed',
            usage: { source: 'unknown' },
            confirmedUsage: {
              inputTokens: 40,
              outputTokens: 4,
              cachedInputTokens: 0,
              source: 'reported',
            },
          }),
        ],
      ),
      conversation,
    );
    expect(stats.usage).toMatchObject({
      total: 44,
      knownRuns: 1,
      completeRuns: 0,
      complete: false,
      missingRuns: 1,
    });
    expect(stats.usage).toMatchObject({ cachePercent: 0, cacheComplete: false });
  });

  it('computes model-request rate with its matching output and independent timing, not tool and approval time', () => {
    const data = snapshot(
      [task('a')],
      [
        run('a', 'a', '1', {
          modelDurationMs: 2000,
          inferenceDurationMs: 100000,
          inferenceUsage: { outputTokens: 100, source: 'reported' },
          usage: { inputTokens: 1000, outputTokens: 200, source: 'reported' },
        }),
      ],
    );
    expect(conversationStatistics(data, conversation).rate).toBe(50);
    delete data.runs[0].modelDurationMs;
    expect(conversationStatistics(data, conversation).rate).toBeUndefined();
  });

  it('keeps native and App estimated context separate and never reuses a previous run context', () => {
    const data = snapshot(
      [task('a')],
      [run('a', 'a', '1')],
      [
        event('a', 'context', {
          source: 'app-estimated',
          estimatedTokens: 25,
          contextWindow: 100,
          availableTokens: 80,
        }),
      ],
    );
    expect(conversationStatistics(data, conversation).context).toMatchObject({
      source: 'estimated',
      percent: 25,
      available: 80,
    });
    data.events.push(
      event(
        'a',
        'context',
        { source: 'native-reported', usedPercentage: 0, estimatedTokens: 70 },
        '2026-10-12T00:01:00Z',
      ),
    );
    expect(conversationStatistics(data, conversation).context).toMatchObject({
      source: 'reported',
      percent: 0,
      used: undefined,
    });
    data.runs.push(run('b', 'a', '2'));
    expect(conversationStatistics(data, conversation).context.percent).toBeUndefined();
  });

  it('preserves known request counts and complete zero without relying on events', () => {
    const data = snapshot(
      [task('a')],
      [run('a', 'a', '1', { modelRequestCount: 80 }), run('b', 'a', '2', { status: 'failed' })],
    );
    expect(conversationStatistics(data, conversation)).toMatchObject({
      requests: 80,
      requestsComplete: false,
      unknownRequestRuns: 1,
    });
    data.runs = [
      run('zero', 'a', '3', { metrics: { requests: 0, summaryRequests: 0, usageRequests: 0 } }),
    ];
    expect(conversationStatistics(data, conversation)).toMatchObject({
      requests: 0,
      requestsComplete: true,
      summaryRequests: 0,
    });
    expect(conversationStatistics(snapshot([], []), conversation)).toMatchObject({
      requests: 0,
      requestsComplete: true,
    });
  });

  it('weights only paired cache inputs and keeps request and historical coverage separate', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('new', 'a', '1', {
            metrics: {
              requests: 3,
              summaryRequests: 1,
              usageRequests: 3,
              usage: { inputTokens: 1000, outputTokens: 100, source: 'reported' },
              cache: { inputTokens: 100, cachedInputTokens: 50, requests: 2 },
            },
          }),
          run('old', 'a', '2', {
            usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 30, source: 'reported' },
          }),
          run('failed', 'a', '3', { status: 'failed' }),
        ],
      ),
      conversation,
    );
    expect(stats).toMatchObject({ requests: 3, unknownRequestRuns: 2, summaryRequests: 1 });
    expect(stats.usage).toMatchObject({
      input: 1300,
      cached: 50,
      cacheInput: 400,
      cachePercent: 12.5,
      cacheRequests: 2,
      cacheTotalRequests: 3,
      cacheLegacyRuns: 1,
      cacheLegacyTotalRuns: 2,
      cacheComplete: false,
    });
  });

  it('does not interpret zero input as a zero cache hit rate', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', {
            metrics: {
              requests: 1,
              summaryRequests: 0,
              usageRequests: 1,
              cache: { inputTokens: 0, cachedInputTokens: 0, requests: 1 },
            },
          }),
        ],
      ),
      conversation,
    );
    expect(stats.usage).toMatchObject({ cacheInput: 0, cached: 0, cacheComplete: true });
    expect(stats.usage.cachePercent).toBeUndefined();
  });

  it('uses persisted matching rate samples rather than total usage or whole-run duration', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', {
            modelDurationMs: 100000,
            inferenceUsage: { outputTokens: 99999, source: 'reported' },
            metrics: {
              requests: 4,
              summaryRequests: 1,
              usageRequests: 2,
              usage: { inputTokens: 1000, outputTokens: 500, source: 'reported' },
              rate: { outputTokens: 60, durationMs: 2000, requests: 2, source: 'estimated' },
            },
          }),
        ],
      ),
      conversation,
    );
    expect(stats).toMatchObject({
      requests: 4,
      summaryRequests: 1,
      rate: 30,
      rateEstimated: true,
      ratePartial: true,
      rateRequests: 2,
    });
    expect(stats.usage).toMatchObject({ total: 1500, complete: false });
  });

  it.each(['running', 'failed', 'cancelled'] as const)(
    'retains a clearly identified previous model rate when the latest run is %s',
    (status) => {
      const data = snapshot(
        [task('a')],
        [
          run('old', 'a', '1', {
            model: 'previous-model',
            modelDurationMs: 2000,
            inferenceUsage: { outputTokens: 100, source: 'reported' },
          }),
          run('new', 'a', '2', {
            status,
            model: 'current-model',
            metrics: { requests: 1, summaryRequests: 0, usageRequests: 0 },
            confirmedUsage: { outputTokens: 9000, source: 'reported' },
            modelDurationMs: 100,
          }),
        ],
      );
      const stats = conversationStatistics(data, conversation);
      expect(stats).toMatchObject({
        rate: 50,
        rateFromPrevious: true,
        rateRun: { id: 'old', model: 'previous-model' },
      });
      expect(stats.rateMissingReason).toContain(
        status === 'running' ? '统计中' : status === 'failed' ? '失败' : '取消',
      );
      const html = renderToStaticMarkup(
        createElement(StatisticsDetails, {
          id: 'stats',
          panel: 'activity',
          stats,
          rate: '50.0 tok/s',
          close: () => {},
        }),
      );
      expect(html).toContain('最近有效请求速率');
      expect(html).toContain('previous-model');
      expect(html).toContain('old');
      expect(html).toContain('current-model');
    },
  );

  it('distinguishes native collection gaps, current sampling, and missing historical records', () => {
    const data = {
      ...snapshot([task('a')], [run('a', 'a', '1', { connectionId: 'native' })]),
      connections: [{ id: 'native', provider: 'antigravity' }] as Snapshot['connections'],
    };
    expect(conversationStatistics(data, conversation).missingReason).toBe('agy 运行时未提供');
    data.connections[0].provider = 'qoder';
    expect(conversationStatistics(data, conversation).rateMissingReason).toBe('Qoder 暂未采集');
    data.connections = [];
    expect(conversationStatistics(data, conversation).missingReason).toBe('历史未记录');
    data.runs[0].status = 'running';
    expect(conversationStatistics(data, conversation).rateMissingReason).toBe('统计中');
  });

  it('rejects invalid cache and timing buckets without falling back to unmatched totals', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', {
            modelDurationMs: 1000,
            inferenceUsage: { outputTokens: 100, source: 'reported' },
            metrics: {
              requests: 1,
              summaryRequests: 0,
              usageRequests: 0,
              rate: { requests: 2, outputTokens: 100, durationMs: 1000, source: 'reported' },
              cache: { requests: 1, inputTokens: 10, cachedInputTokens: 11 },
            },
          }),
        ],
      ),
      conversation,
    );
    expect(stats.rate).toBeUndefined();
    expect(stats.usage.cachePercent).toBeUndefined();
    expect(stats.usage.cached).toBeUndefined();
  });

  it('keeps the compact view short and exposes partial coverage in details', () => {
    const data = snapshot(
      [task('a')],
      [
        run('a', 'a', '1', {
          modelRequestCount: 80,
          usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 50, source: 'reported' },
        }),
        run('b', 'a', '2', { status: 'running' }),
      ],
    );
    const html = renderToStaticMarkup(
      createElement(ConversationStats, { data: data as Snapshot, conversation }),
    );
    expect(html).toContain('80 次请求');
    expect(html).not.toContain('请求速率 统计中');
    expect(html).toContain('缓存 50.0%');
    expect(html).toContain('部分数据');
    const stats = conversationStatistics(data, conversation);
    const details = renderToStaticMarkup(
      createElement(StatisticsDetails, {
        id: 'usage',
        panel: 'usage',
        stats,
        rate: '—',
        close: () => {},
      }),
    );
    expect(details).toContain('<details');
    expect(details).toContain('缓存样本输入');
    expect(details).toContain('原生与历史缓存记录');
    expect(details).toContain('用量为已报告部分');
  });
  it('does not mark waiting native usage complete and caps only the context meter', () => {
    const stats = conversationStatistics(
      snapshot(
        [task('a')],
        [
          run('a', 'a', '1', {
            status: 'waiting_input',
            usage: { inputTokens: 100, outputTokens: 10, source: 'reported' },
            contextUsage: { source: 'app-estimated', estimatedTokens: 120, contextWindow: 100 },
          }),
        ],
      ),
      conversation,
    );
    expect(stats.usage.complete).toBe(false);
    expect(stats.context.percent).toBe(120);
    const html = renderToStaticMarkup(
      createElement(StatisticsDetails, {
        id: 'context',
        panel: 'context',
        stats,
        rate: '—',
        close: () => {},
      }),
    );
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('已超过窗口');
  });
});
