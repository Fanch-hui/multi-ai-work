import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Artifact, Task } from '../src/domain/types.js';
import type { ArtifactReview } from '../src/domain/artifact-review.js';
import type { Routine } from '../src/domain/routines.js';
import type { TaskWait } from '../src/domain/task-wait.js';
import {
  ArtifactReviewActions,
  reviewLabel,
  sameReviewTask,
  reviewMatchesArtifacts,
} from '../apps/ui/src/local-work/ArtifactReview.js';
import { routineScheduleLabel } from '../apps/ui/src/local-work/Routines.js';
import { TaskWaitCard } from '../apps/ui/src/local-work/TaskWaitCard.js';

const mutate = async () => undefined as never;
const artifact = {
  id: 'version-1',
  name: '报告.pdf',
  conversationId: 'room',
  purpose: 'deliverable',
} as Artifact;
const wait: TaskWait = {
  id: 'wait',
  taskId: 'task',
  botId: 'member',
  runId: 'run',
  conversationId: 'room',
  kind: 'browser-handoff',
  status: 'pending',
  summary: '请完成网站验证',
  createdAt: '2026-10-23T10:00:00Z',
};

describe('local work surfaces', () => {
  it('offers review only for final deliverables, preserving uploaded and intermediate files', () => {
    const render = (value: Artifact) =>
      renderToStaticMarkup(createElement(ArtifactReviewActions, { artifacts: [value], mutate }));
    expect(render(artifact)).toContain('审阅');
    expect(render({ ...artifact, source: 'user-attachment' })).toBe('');
    expect(render({ ...artifact, purpose: 'intermediate' })).toBe('');
  });

  it('distinguishes user acceptance from a bot passing a review', () => {
    const review = { reviewer: 'user', outcome: 'accepted' } as ArtifactReview;
    expect(reviewLabel(review)).toBe('用户已接受');
    expect(reviewLabel({ ...review, reviewer: 'bot', outcome: 'passed' })).toBe('AI 复核通过');
    expect(reviewLabel({ ...review, outcome: 'changes_requested' })).toBe('要求修改');
  });

  it('renders handoff as browser intervention and approval as resumption', () => {
    const handoff = renderToStaticMarkup(
      createElement(TaskWaitCard, { wait, mutate, onBrowser: () => {} }),
    );
    expect(handoff).toContain('打开工作浏览器');
    expect(handoff).not.toContain('继续处理</button>');
    const approval = renderToStaticMarkup(
      createElement(TaskWaitCard, { wait: { ...wait, kind: 'approval' }, mutate }),
    );
    expect(approval).toContain('继续处理');
    expect(approval).not.toContain('打开工作浏览器');
    expect(
      renderToStaticMarkup(
        createElement(TaskWaitCard, { wait: { ...wait, status: 'resumed' }, mutate }),
      ),
    ).toBe('');
  });

  it('keeps schedule time zones and weekday values visible', () => {
    const routine = {
      schedule: { kind: 'weekly', time: '09:30', weekdays: [0, 1, 6] },
      timeZone: 'America/New_York',
    } as Routine;
    expect(routineScheduleLabel(routine)).toBe('每周日、一、六 09:30 · America/New_York');
    expect(
      routineScheduleLabel({
        ...routine,
        schedule: { kind: 'daily', time: '18:00' },
        timeZone: 'Asia/Shanghai',
      }),
    ).toBe('每日 18:00 · Asia/Shanghai');
  });
  it('enables batch review only for a complete, shared source task tree', () => {
    const tasks = [
      { id: 'root' },
      { id: 'child-a', parentId: 'root' },
      { id: 'child-b', parentId: 'root' },
      { id: 'other' },
    ] as Task[];
    const files = [
      { ...artifact, taskId: 'child-a' },
      { ...artifact, id: 'second', taskId: 'child-b' },
    ];
    expect(sameReviewTask(files, tasks)).toBe(true);
    expect(sameReviewTask([...files, { ...artifact, taskId: 'other' }], tasks)).toBe(false);
    expect(
      sameReviewTask(
        files,
        tasks.filter((task) => task.id !== 'root'),
      ),
    ).toBe(false);
    expect(sameReviewTask([{ ...artifact, taskId: undefined }], tasks)).toBe(false);
  });
  it('retains transferred-copy review history alongside the original target', () => {
    const review = {
      targets: [{ artifactId: 'original' }],
      reviewInputArtifactIds: ['transferred-copy'],
    } as Pick<ArtifactReview, 'targets'> & { reviewInputArtifactIds: string[] };
    expect(reviewMatchesArtifacts(review, new Set(['original']))).toBe(true);
    expect(reviewMatchesArtifacts(review, new Set(['transferred-copy']))).toBe(true);
    expect(reviewMatchesArtifacts(review, new Set(['unrelated']))).toBe(false);
    expect(reviewMatchesArtifacts({ targets: review.targets }, new Set(['original']))).toBe(true);
  });
});
