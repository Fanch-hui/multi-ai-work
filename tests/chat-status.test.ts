import { describe, expect, it } from 'vitest';
import type { Run, RunEvent, Task } from '../src/domain/types.js';
import { agentActivity } from '../apps/ui/src/AgentActivity.js';

const time = '2026-10-22T12:00:00Z';
const thinking = /^(正在梳理思路|正把线索串起来|正在琢磨下一步|换个角度想一想|正在理顺关键细节)$/;
const working =
  /^(正在着手处理|正在逐项推进|正忙着把事情做扎实|正在处理手头工作|正在把细节落到实处)$/;
const task: Task = {
  id: 'task',
  botId: 'member',
  conversationId: 'room',
  dependencyIds: [],
  goal: '整理资料',
  expectedOutput: '',
  status: 'running',
  runIds: ['run'],
  artifactIds: [],
  requestId: 'request',
  depth: 0,
  createdAt: time,
  updatedAt: time,
  activity: { phase: 'model', modelActivity: 'waiting', activityKey: 'request-1' },
};
const run: Run = {
  id: 'run',
  taskId: task.id,
  botId: task.botId,
  bindingId: 'binding',
  configRevision: 1,
  status: 'running',
  createdAt: time,
};
function event(
  id: string,
  type: RunEvent['type'],
  data: RunEvent['data'],
  runId = run.id,
): RunEvent {
  return { id, runId, type, data, createdAt: time };
}

describe('chat status phrases', () => {
  it('keeps the initial wait until actual model output and ignores empty or diagnostic events', () => {
    const events = [
      event('request', 'status', { phase: 'model-request' }),
      event('heartbeat', 'status', { phase: 'model-activity', activityKind: 'working' }),
      event('empty', 'text', { delta: '' }),
      event('usage', 'usage', { inputTokens: 20 }),
      event('cache', 'status', { phase: 'model-cache-response', cachedInputTokens: 20 }),
      event('ack', 'status', { phase: 'response.created' }),
    ];
    expect(agentActivity(task, run, events)).toBe('正在等待响应');
    for (const kind of ['thinking', 'working', 'tool'] as const)
      expect(
        agentActivity({ ...task, activity: { phase: 'model', modelActivity: kind } }, run, events),
      ).toBe('正在等待响应');
    for (const output of [
      event('text', 'text', { delta: '正在检查资料' }),
      event('reasoning', 'status', { reasoning: '核对来源' }),
      event('tool', 'tool', { name: 'read_file', callId: 'read', phase: 'started' }),
      event('started', 'status', { phase: 'model-work-started' }),
    ])
      expect(agentActivity(task, run, [...events, output])).toMatch(thinking);
  });

  it('retains task-level progress through supplemental input, continuation, new runs and restart', () => {
    const continued: Task = {
      ...task,
      runIds: ['run', 'continued'],
      activity: {
        ...task.activity!,
        firstModelOutputAt: time,
        activityKey: 'next-request',
      },
    };
    const nextRun = { ...run, id: 'continued' };
    const label = agentActivity(continued, nextRun);
    expect(label).toMatch(thinking);
    expect(agentActivity(JSON.parse(JSON.stringify(continued)), nextRun)).toBe(label);
    expect(
      agentActivity(continued, nextRun, [event('input', 'status', { phase: 'input-delivered' })]),
    ).toBe(label);
    expect(
      agentActivity(
        { ...continued, activity: { ...continued.activity!, firstModelOutputAt: undefined } },
        nextRun,
        [event('earlier-output', 'text', { delta: '已读取资料' })],
      ),
    ).toMatch(thinking);
  });

  it('keeps summary model activity and replacement drafts out of the first-output evidence', () => {
    const ignored = [
      event('summary-started', 'status', { phase: 'model-work-started', scope: 'compaction' }),
      event('summary-request', 'status', { phase: 'model-request', scope: 'compaction' }),
      event('summary-text', 'text', { delta: '汇总此前记录', scope: 'compaction' }),
      event('replacement', 'text', { delta: '恢复的旧草稿', replace: true }),
      event('empty-replacement', 'text', { text: '恢复的旧草稿', replace: false }),
    ];
    expect(agentActivity(task, run, ignored)).toBe('正在等待响应');
    const older = { ...task, activity: undefined };
    const preparing = agentActivity(older, run);
    expect(agentActivity(older, run, ignored)).toBe(preparing);
    expect(
      agentActivity(older, run, [
        event('request', 'status', { phase: 'model-request' }),
        ...ignored,
      ]),
    ).toBe('正在等待响应');
  });

  it('starts a new initial wait for a new task sharing the same binding', () => {
    const next = { ...task, id: 'another-task', runIds: ['new-run'] };
    const nextRun = { ...run, id: 'new-run', taskId: next.id };
    expect(
      agentActivity(next, nextRun, [event('earlier-output', 'text', { delta: '已完成上项工作' })]),
    ).toBe('正在等待响应');
  });

  it('keeps phrases stable while tokens, timestamps and unrelated diagnostics change', () => {
    const responding: Task = {
      ...task,
      activity: { phase: 'responding', activityKey: 'response-1', firstModelOutputAt: time },
    };
    const label = agentActivity(responding, run);
    for (let token = 0; token < 30; token++) {
      expect(
        agentActivity(
          {
            ...responding,
            updatedAt: `${token}`,
            activity: { ...responding.activity!, lastActivityAt: `${token}` },
          },
          run,
          [event(`token-${token}`, 'text', { delta: `${token}` })],
          true,
        ),
      ).toBe(label);
    }
    const labels = new Set(
      Array.from({ length: 20 }, (_, operation) =>
        agentActivity({
          ...task,
          activity: { phase: 'tool', activityKey: `operation-${operation}` },
        }),
      ),
    );
    expect(labels.size).toBeGreaterThan(1);
    for (const label of labels) expect(label).toMatch(working);
  });

  it('uses distinct natural phrases for each phase and keeps explicit waiting and terminal states', () => {
    const labels = [
      agentActivity({ ...task, activity: { phase: 'preparing' } }),
      agentActivity({
        ...task,
        activity: { phase: 'model', modelActivity: 'thinking', firstModelOutputAt: time },
      }),
      agentActivity({ ...task, activity: { phase: 'tool' } }),
      agentActivity({ ...task, activity: { phase: 'responding' } }),
      agentActivity({ ...task, activity: { phase: 'compacting' } }),
      agentActivity({
        ...task,
        activity: { phase: 'model', modelActivity: 'finishing', firstModelOutputAt: time },
      }),
    ];
    expect(new Set(labels).size).toBe(6);
    for (const [phase, expected] of [
      ['approval', '等待批准'],
      ['input', '等待回答'],
      ['children', '等待成员任务'],
      ['stopping', '停止处理中'],
    ] as const)
      expect(agentActivity({ ...task, activity: { phase } })).toBe(expected);
    expect(agentActivity({ ...task, status: 'failed' })).toBe('失败');
    expect(agentActivity(task, { ...run, cancelRequestedAt: time })).toBe('停止处理中');
  });

  it('uses consecutive operation ordinals to avoid repeating a phrase within each phase', () => {
    for (const activity of [
      { phase: 'preparing' },
      { phase: 'model', modelActivity: 'thinking' },
      { phase: 'tool' },
      { phase: 'responding' },
      { phase: 'compacting' },
      { phase: 'model', modelActivity: 'finishing' },
    ] as const) {
      let previous: string | undefined;
      for (let ordinal = 1; ordinal <= 20; ordinal++) {
        const current: Task = {
          ...task,
          activity: {
            ...activity,
            firstModelOutputAt: time,
            activityKey: `request-${ordinal * 9}:${ordinal}`,
          },
        };
        const label = agentActivity(current, run);
        expect(label).not.toBe(previous);
        expect(agentActivity(current, run)).toBe(label);
        expect(
          agentActivity(
            {
              ...current,
              activity: { ...current.activity!, activityKey: `different-id:${ordinal}` },
            },
            run,
          ),
        ).toBe(label);
        previous = label;
      }
    }
  });

  it('keeps an outstanding parallel tool visible after another tool completes in older data', () => {
    const older = { ...task, activity: undefined };
    const events = [
      event('a', 'tool', { name: 'read_file', callId: 'a', status: 'started' }),
      event('b', 'tool', { name: 'search_web', callId: 'b', status: 'started' }),
      event('a-done', 'tool', { name: 'read_file', callId: 'a', status: 'completed' }),
    ];
    expect(agentActivity(older, run, events)).toMatch(working);
    expect(
      agentActivity(older, run, [
        ...events,
        event('b-done', 'tool', { name: 'search_web', callId: 'b', status: 'completed' }),
      ]),
    ).toMatch(thinking);
  });
});
