import { describe, expect, it, vi } from 'vitest';
import type { Run, RunEvent, Task } from '../src/domain/types.js';
import { taskActivity } from '../src/core/task-activity.js';
import { setup } from './core-harness.js';

describe('批量任务活动快照', () => {
  it('恢复等待显示重试进度，替换草稿不伪造模型活动', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const s = core.state.storage;
    const task: Task = { id: 'recovery-task', botId: core.state.settings().mainBotId!,
      conversationId: core.state.settings().mainConversationId!, status: 'running', runIds: ['recovery-run'],
      dependencyIds: [], artifactIds: [], goal: '工作', expectedOutput: '', requestId: 'request', depth: 0,
      createdAt: '', updatedAt: '' };
    s.put('tasks', task);
    s.put('runs', { id: 'recovery-run', taskId: task.id, botId: task.botId, bindingId: 'binding',
      status: 'running', configRevision: 1, createdAt: '2026-10-15T01:00:00Z' });
    s.event({ id: 'activity', runId: 'recovery-run', type: 'status', data: { phase: 'model-activity' }, createdAt: '2026-10-15T01:00:01Z' });
    s.event({ id: 'retry', runId: 'recovery-run', type: 'status', data: { phase: 'model-retry', attempt: 2, maxAttempts: 5,
      nextAttemptAt: '2026-10-15T01:00:08Z', code: 'ERR_CONNECTION_RESET' }, createdAt: '2026-10-15T01:00:03Z' });
    s.event({ id: 'replace', runId: 'recovery-run', type: 'text', data: { replace: '' }, createdAt: '2026-10-15T01:00:04Z' });
    const activity = taskActivity(s, task);
    expect(activity).toMatchObject({ phase: 'recovering', lastModelActivityAt: '2026-10-15T01:00:01Z',
      recovery: { attempt: 2, maxAttempts: 5, nextAttemptAt: '2026-10-15T01:00:08Z', reason: 'ERR_CONNECTION_RESET' } });
    expect(core.state.snapshot().tasks[0].activity).toEqual(activity);
  });

  it('保持每项任务的实际活动与最新检查点，历史规模增长时不逐项查询事件', async () => {
    const { core } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const s = core.state.storage, roomId = core.state.settings().mainConversationId!;
    const cases: { event?: Pick<RunEvent, 'type' | 'data'>; status: Task['status']; phase: string }[] = [
      { status: 'running', event: { type: 'text', data: { delta: '答复' } }, phase: 'responding' },
      { status: 'running', event: { type: 'tool', data: { status: 'started', name: 'read_file' } }, phase: 'tool' },
      { status: 'running', event: { type: 'compaction', data: { status: 'started' } }, phase: 'compacting' },
      { status: 'running', event: { type: 'status', data: { phase: 'model-retry' } }, phase: 'model' },
      { status: 'queued', phase: 'queued' }, { status: 'completed', phase: 'finished' },
      { status: 'waiting_input', phase: 'input' }, { status: 'waiting_approval', phase: 'approval' },
    ];
    for (let index = 0; index < 160; index++) {
      const selected = cases[index % cases.length];
      const task: Task = { id: `task-${index}`, botId: core.state.settings().mainBotId!, conversationId: roomId,
        status: selected.status, runIds: [`run-${index}`], dependencyIds: [], artifactIds: [], goal: '工作',
        expectedOutput: '', requestId: `request-${index}`, depth: 0, createdAt: '', updatedAt: '' };
      const run: Run = { id: task.runIds[0], taskId: task.id, botId: task.botId, bindingId: 'shared-binding',
        status: 'running', configRevision: 1, createdAt: '2026-10-15T01:00:00Z' };
      s.put('tasks', task); s.put('runs', run);
      if (selected.event) s.event({ id: `event-${index}`, runId: run.id, ...selected.event, createdAt: '2026-10-15T01:01:00Z' });
      s.event({ id: `usage-${index}`, runId: run.id, type: 'usage', data: {}, createdAt: '2026-10-15T01:02:00Z' });
    }
    s.put('context_checkpoints', { id: 'old', bindingId: 'shared-binding' });
    s.put('context_checkpoints', { id: 'new', bindingId: 'shared-binding' });
    core.state.queueReasonFor = task => task.status === 'queued' ? 'account_limit' : undefined;
    const queries = vi.spyOn(s, 'prepare');
    const snapshot = core.state.snapshot();
    expect(queries.mock.calls.filter(([sql]) => sql.includes('FROM run_events'))).toHaveLength(2);
    queries.mockRestore();
    for (let index = 0; index < snapshot.tasks.length; index++) {
      const task = snapshot.tasks[index];
      expect(task.activity).toEqual(taskActivity(s, task));
      expect(task.activity).toMatchObject({ phase: cases[index % cases.length].phase, checkpointId: 'new' });
      if (task.status === 'queued') expect(task.activity?.waitingFor).toBe('模型账号并发名额');
    }
    s.event({ id: 'latest', runId: 'run-0', type: 'tool', data: { status: 'started', name: 'write_file' }, createdAt: '2026-10-15T01:03:00Z' });
    s.put('context_checkpoints', { id: 'newest', bindingId: 'shared-binding' });
    expect(core.state.snapshot().tasks[0].activity).toMatchObject({ phase: 'tool', toolName: 'write_file',
      lastActivityAt: '2026-10-15T01:03:00Z', checkpointId: 'newest' });
  });
});
