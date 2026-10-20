import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types.js';
import { CompactionStatus } from '../apps/ui/src/ContextCompactionControl.js';
import {
  compactionFeedback,
  latestCompactionTask,
} from '../apps/ui/src/context-compaction-state.js';

const time = '2026-10-18T16:00:00.000Z';
const task = (status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id: 'compact',
  conversationId: 'main',
  botId: 'chief',
  kind: 'context-compaction',
  dependencyIds: [],
  goal: '',
  expectedOutput: '',
  status,
  runIds: [],
  artifactIds: [],
  requestId: 'request',
  depth: 0,
  createdAt: time,
  updatedAt: time,
  ...extra,
});

describe('manual context compaction feedback', () => {
  it('immediately shows progress while submission is pending and hides the previous outcome', () => {
    const feedback = compactionFeedback(task('completed', { result: '上次压缩结果' }), 'start')!;
    expect(feedback).toMatchObject({
      label: '正在准备压缩…',
      busy: true,
      cancellable: false,
      tone: 'progress',
    });
    const html = renderToStaticMarkup(createElement(CompactionStatus, { feedback }));
    expect(html).toContain('正在准备压缩…');
    expect(html).toContain('motion-safe:animate-spin');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('上次压缩结果');
  });

  it.each([
    ['queued', '等待压缩…'],
    ['running', '正在压缩…'],
  ] as const)('shows the actual %s task state with a spinner and cancellation', (status, label) => {
    const feedback = compactionFeedback(task(status))!;
    expect(feedback).toMatchObject({ label, busy: true, cancellable: true, tone: 'progress' });
    const html = renderToStaticMarkup(createElement(CompactionStatus, { feedback }));
    expect(html).toContain(label);
    expect(html).toContain('motion-safe:animate-spin');
  });

  it.each([
    ['completed', '压缩完成', 'success', '已整理 20 条较早内容'],
    ['failed', '压缩失败', 'error', '模型连接失败'],
    ['cancelled', '已取消压缩', 'neutral', undefined],
    ['interrupted', '压缩已中断', 'error', '应用已退出'],
  ] as const)(
    'retains the %s outcome and the actual task detail',
    (status, label, tone, detail) => {
      const feedback = compactionFeedback(
        task(status, status === 'completed' ? { result: detail } : { error: detail }),
      )!;
      expect(feedback).toMatchObject({ label, tone, busy: false, cancellable: false });
      const html = renderToStaticMarkup(createElement(CompactionStatus, { feedback }));
      expect(html).toContain(label);
      if (detail) expect(html).toContain(detail);
      expect(html).not.toContain('motion-safe:animate-spin');
      expect(html).toContain(tone === 'error' ? 'role="alert"' : 'role="status"');
    },
  );

  it('shows pending cancellation until the task status confirms its outcome', () => {
    expect(compactionFeedback(task('running'), 'cancel')).toMatchObject({
      label: '正在取消压缩…',
      busy: true,
      cancellable: true,
      tone: 'progress',
    });
    expect(compactionFeedback(task('cancelled'))?.label).toBe('已取消压缩');
  });

  it('shows an unchanged context as a neutral outcome with its explanation', () => {
    const detail = '当前可压缩的历史较少，本次未做改动。';
    const feedback = compactionFeedback(
      task('completed', { contextCompactionOutcome: 'unchanged', result: detail }),
    )!;
    expect(feedback).toMatchObject({
      label: '无需压缩',
      tone: 'neutral',
      busy: false,
      cancellable: false,
    });
    const html = renderToStaticMarkup(createElement(CompactionStatus, { feedback }));
    expect(html).toContain('无需压缩');
    expect(html).toContain(detail);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('text-red-600');
    expect(html).not.toContain('text-emerald-700');
    expect(html).not.toContain('<svg');
  });

  it('keeps actual failures as errors regardless of their explanatory wording', () => {
    const detail = '当前可压缩的历史较少，继续对话后可重试';
    const feedback = compactionFeedback(task('failed', { error: detail }))!;
    expect(feedback).toMatchObject({ label: '压缩失败', tone: 'error', detail });
    const html = renderToStaticMarkup(createElement(CompactionStatus, { feedback }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('text-red-600');
  });

  it('shows a request error instead of stale success and keeps active tasks cancellable', () => {
    expect(
      compactionFeedback(task('completed', { result: '旧结果' }), undefined, '请求失败'),
    ).toEqual({
      label: '操作失败',
      detail: '请求失败',
      busy: false,
      cancellable: false,
      tone: 'error',
    });
    expect(compactionFeedback(task('running'), undefined, '取消失败')).toMatchObject({
      detail: '取消失败',
      busy: true,
      cancellable: true,
    });
  });

  it('associates feedback with the latest compaction in the current conversation and accepts fresher responses', () => {
    const old = task('completed', { id: 'old', result: '旧结果' });
    const latest = task('running', { id: 'latest', createdAt: '2026-10-18T16:01:00.000Z' });
    const other = task('failed', {
      conversationId: 'other',
      createdAt: '2026-10-18T16:02:00.000Z',
    });
    expect(latestCompactionTask([old, other, latest], 'main')).toBe(latest);
    const completed = {
      ...latest,
      status: 'completed' as const,
      updatedAt: '2026-10-18T16:03:00.000Z',
    };
    expect(latestCompactionTask([old, latest, other], 'main', completed)).toBe(completed);
    expect(latestCompactionTask([old, completed], 'main', latest)).toBe(completed);
    const snapshotCompleted = { ...latest, status: 'completed' as const };
    expect(latestCompactionTask([snapshotCompleted], 'main', latest)).toBe(snapshotCompleted);
    expect(latestCompactionTask([old], 'empty', other)).toBeUndefined();
    expect(latestCompactionTask([{ ...latest, kind: undefined }], 'main')).toBeUndefined();
  });

  it('ends terminal feedback after another foreground task while preserving active compaction and background isolation', () => {
    const next = task('queued', {
      id: 'next',
      kind: undefined,
      createdAt: '2026-10-18T16:01:00.000Z',
    });
    const background = (['memory-review', 'question-decision'] as const).map((kind) => ({
      ...next,
      id: kind,
      kind,
    }));
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
      const compact = task(status);
      expect(latestCompactionTask([compact, next], 'main')).toBeUndefined();
      expect(compactionFeedback(latestCompactionTask([compact, next], 'main'))).toBeUndefined();
      expect(latestCompactionTask([compact, ...background], 'main')).toBe(compact);
      expect(latestCompactionTask([compact, { ...next, conversationId: 'other' }], 'main')).toBe(
        compact,
      );
      const newer = { ...compact, id: 'newer', createdAt: '2026-10-18T16:02:00.000Z' };
      expect(latestCompactionTask([compact, next], 'main', newer)).toBe(newer);
    }
    for (const status of ['queued', 'running'] as const) {
      const compact = task(status);
      expect(latestCompactionTask([compact, next], 'main')).toBe(compact);
      expect(
        compactionFeedback(latestCompactionTask([compact, next], 'main'), 'cancel'),
      ).toMatchObject({
        label: '正在取消压缩…',
        busy: true,
      });
    }
  });
});
