import { describe, expect, it, vi } from 'vitest';
import type { Run, RunEvent, RunEventPage, Task } from '../src/domain/types.js';
import { taskActivity } from '../src/core/task-activity.js';
import { Storage } from '../src/core/storage.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core } = await setup(async () => ({ text: 'done' }));
  core.scheduler.pause();
  const task: Task = {
    id: 'task',
    botId: core.state.settings().mainBotId!,
    conversationId: core.state.settings().mainConversationId!,
    status: 'running',
    runIds: ['run'],
    dependencyIds: [],
    artifactIds: [],
    goal: '核对资料',
    expectedOutput: '',
    requestId: 'request',
    depth: 0,
    createdAt: '',
    updatedAt: '',
  };
  const run: Run = {
    id: 'run',
    taskId: task.id,
    botId: task.botId,
    bindingId: 'binding',
    status: 'running',
    configRevision: 1,
    createdAt: '2026-10-22T01:00:00Z',
  };
  const s = core.state.storage;
  s.put('tasks', task);
  s.put('runs', run);
  let sequence = 0;
  const event = (type: RunEvent['type'], data: RunEvent['data'], runId = 'run') => {
    const saved = {
      id: `event-${++sequence}`,
      runId,
      type,
      data,
      createdAt: new Date(Date.UTC(2026, 9, 22, 1, 0, sequence)).toISOString(),
    };
    s.event(saved);
    return saved;
  };
  return { core, s, task, run, event };
}

describe('持久工作活动投影', () => {
  it('排除空事件与后台摘要，首次输出跨运行和存储重开保留，新任务重置', async () => {
    const { s, task, run, event } = await fixture();
    event('status', { phase: 'model-request' });
    event('status', { phase: 'model-activity', activityKind: 'working' });
    event('text', { delta: '' });
    event('text', { replace: '恢复的草稿' });
    event('usage', { outputTokens: 10 });
    event('status', { phase: 'model-work-started', scope: 'compaction' });
    expect(taskActivity(s, task).firstModelOutputAt).toBeUndefined();
    const first = event('status', { phase: 'model-work-started' });
    const nextTask = { ...task, runIds: ['run', 'continued'] };
    s.put('runs', { ...run, id: 'continued' });
    s.put('tasks', nextTask);
    event('status', { phase: 'model-request' }, 'continued');
    expect(taskActivity(s, nextTask)).toMatchObject({
      firstModelOutputAt: first.createdAt,
      modelActivity: 'waiting',
    });
    const reopened = new Storage(s.path);
    try {
      expect(taskActivity(reopened, nextTask).firstModelOutputAt).toBe(first.createdAt);
      expect(
        taskActivity(reopened, { ...task, id: 'new-task', runIds: ['continued'] })
          .firstModelOutputAt,
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it('旧数据只由实际正文或命名工具确认输出，正文更新不改变阶段选择', async () => {
    const { s, task, event } = await fixture();
    event('status', { phase: 'model-request' });
    const first = event('text', { delta: '开始' });
    const activity = taskActivity(s, task);
    event('text', { delta: '处理' });
    expect(taskActivity(s, task)).toMatchObject({
      firstModelOutputAt: first.createdAt,
      activityKey: activity.activityKey,
    });
    event('status', { phase: 'model-request' });
    expect(taskActivity(s, task).activityKey).toMatch(/:2$/);
  });

  it('并行部分完成保留其他操作，跨大量历史仍有界，结束后清空', async () => {
    const { s, task, run, event } = await fixture();
    for (let i = 0; i < 6; i++)
      event('tool', {
        callId: `active-${i}`,
        name: 'read_file',
        status: 'running',
        summary: '读取资料'.repeat(100),
        args: { private: 'raw' },
      });
    for (let i = 0; i < 220; i++) {
      event('tool', { callId: `done-${i}`, name: 'read_file', status: 'running' });
      event('tool', { callId: `done-${i}`, name: 'read_file', status: 'completed', source: 'app' });
    }
    event('tool', { callId: 'done-219', name: 'read_file', status: 'running', source: 'native' });
    const queries = vi.spyOn(s, 'prepare');
    const before = taskActivity(s, task);
    const projectionSql = queries.mock.calls.find(([sql]) => sql.includes('WITH work_rows'))![0];
    queries.mockRestore();
    const queryPlan = s.prepare(`EXPLAIN QUERY PLAN ${projectionSql}`).all('["run"]', '["run"]');
    expect(JSON.stringify(queryPlan)).toContain('nontext_events_by_run');
    expect(before).toMatchObject({ phase: 'tool', operationCount: 6 });
    expect(before.operations).toHaveLength(4);
    expect(before.operations?.every((op) => op.summary?.length === 240)).toBe(true);
    expect(JSON.stringify(before)).not.toContain('private');
    event('tool', { callId: 'active-5', name: 'read_file', status: 'completed' });
    event('status', { phase: 'model-activity', activityKind: 'thinking' });
    expect(taskActivity(s, task)).toMatchObject({ phase: 'tool', operationCount: 5 });
    expect(taskActivity(s, task).operations?.map((op) => op.callId)).not.toContain('active-5');
    s.put('runs', { ...run, status: 'completed', endedAt: '2026-10-22T02:00:00Z' });
    expect(taskActivity(s, { ...task, status: 'completed' })).toMatchObject({
      phase: 'finished',
      operations: [],
      operationCount: 0,
    });
  });

  it('明确等待和恢复优先于活跃工具，投影不改写业务或检查点', async () => {
    const { s, task, event } = await fixture();
    event('tool', { callId: 'a', name: 'read_file', status: 'running' });
    const checkpoint = {
      id: 'checkpoint',
      bindingId: 'binding',
      messages: [{ role: 'tool', callId: 'a', content: '真实结果' }],
      cacheKey: 'stable',
    };
    s.put('context_checkpoints', checkpoint);
    for (const [status, phase] of [
      ['waiting_approval', 'approval'],
      ['waiting_input', 'input'],
      ['waiting_children', 'children'],
    ] as const)
      expect(taskActivity(s, { ...task, status })).toMatchObject({ phase, operationCount: 1 });
    event('status', {
      phase: 'model-retry',
      attempt: 1,
      maxAttempts: 5,
      nextAttemptAt: '2026-10-22T03:00:00Z',
    });
    expect(taskActivity(s, task).phase).toBe('recovering');
    expect(s.get('context_checkpoints', 'checkpoint')).toEqual(checkpoint);
    expect(s.get('tasks', task.id)).toEqual(task);
  });
});

describe('精简工作记录分页', () => {
  it('默认每页50且跨200条游标完整，省略view仍提供原始诊断', async () => {
    const { core, s, event } = await fixture();
    const start = event('tool', {
      callId: 'long-call',
      name: 'read_file',
      status: 'running',
      summary: '读取《资料.md》',
    });
    for (let i = 0; i < 205; i++) {
      event('status', { phase: 'performance', raw: 'diagnostic' });
      event('text', { delta: 'text' });
      event('tool', {
        callId: `call-${i}`,
        name: 'read_file',
        status: 'completed',
        summary: '摘要',
        arguments: { hidden: 'original args' },
        result: 'original result',
      });
    }
    const end = event('tool', { callId: 'long-call', name: 'read_file', status: 'completed' });
    event('status', {
      phase: 'model-retry',
      attempt: 1,
      maxAttempts: 5,
      nextAttemptAt: 'later',
      error: 'raw detail',
    });
    event('status', { phase: 'model-error', scope: 'compaction' });
    const first = (await core.request('runs.events', { id: 'run', view: 'work' })) as RunEventPage;
    expect(first.events).toHaveLength(50);
    expect(first.events.some((e) => e.id === end.id)).toBe(true);
    const all = [...first.events];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = (await core.request('runs.events', {
        id: 'run',
        view: 'work',
        cursor,
      })) as RunEventPage;
      all.unshift(...page.events);
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(208);
    expect(new Set(all.map((e) => e.id)).size).toBe(208);
    expect(all[0].id).toBe(start.id);
    expect(JSON.stringify(all)).not.toMatch(/original args|original result|raw detail|diagnostic/);
    const legacy = (await core.request('runs.events', { id: 'run' })) as RunEventPage;
    expect(legacy).toEqual(s.runEvents('run'));
    expect(legacy.events).toHaveLength(200);
    expect(JSON.stringify(legacy)).toContain('original args');
    await expect(core.request('runs.events', { id: 'run', view: 'invalid' })).rejects.toThrow();
  });
});
