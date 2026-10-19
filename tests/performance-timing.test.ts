import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent } from '../src/domain/provider.js';
import type { Run, RunEvent, Task } from '../src/domain/types.js';
import { ToolRuntime } from '../src/core/tool-runtime.js';
import { ModelRequest } from '../src/providers/managed/request.js';
import { createToolRegistry } from '../src/tools/index.js';
import { runPerformance } from '../apps/ui/src/run-performance.js';
import { setup } from './core-harness.js';

afterEach(() => vi.restoreAllMocks());

describe('性能分段与授权准备', () => {
  it('首事件和首输出分别计时，每次请求各记录一次', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const events: ProviderEvent[] = [];
    const request = new ModelRequest(
      {
        signal: new AbortController().signal,
        emit: (event) => {
          events.push(event);
        },
      },
      'run:1',
    );
    try {
      clock = 40;
      request.activity('response.created', false);
      clock = 75;
      request.activity('response.in_progress', false);
      clock = 100;
      request.activity('response.output_item.done', true);
      request.toolReady('read_file', 'call');
      request.toolReady('read_file', 'call');
      clock = 150;
      request.activity('response.completed', true);
      expect(
        events.filter((event) => event.data.phase === 'performance').map((event) => event.data),
      ).toEqual([
        { phase: 'performance', stage: 'model-first-event', requestId: 'run:1', durationMs: 40 },
        { phase: 'performance', stage: 'model-first-output', requestId: 'run:1', durationMs: 100 },
        {
          phase: 'performance',
          stage: 'tool-ready',
          requestId: 'run:1',
          durationMs: 100,
          name: 'read_file',
          callId: 'call',
        },
      ]);
    } finally {
      request.close();
    }
  });

  it('独立计算本轮总耗时，保留并行分项累计且缺少样本时不补零', () => {
    const run = {
      id: 'run',
      createdAt: '2026-10-18T00:00:00Z',
      endedAt: '2026-10-18T00:00:01Z',
      modelDurationMs: 900,
    } as Run;
    const event = (runId: string, data: Record<string, unknown>): RunEvent => ({
      id: 'event',
      runId,
      type: 'status',
      data: { phase: 'performance', ...data },
      createdAt: run.createdAt,
    });
    const data = runPerformance(run, [
      event('run', { stage: 'tool-ready', callId: 'call' }),
      event('run', {
        scope: 'tool',
        callId: 'call',
        startedAt: '2026-10-18T00:00:00.100Z',
        durationMs: 800,
        durations: { executionMs: 700, networkQueueMs: 100 },
      }),
      event('run', {
        scope: 'tool',
        durationMs: 800,
        durations: { executionMs: 750, networkQueueMs: 50 },
      }),
      event('run', { stage: 'checkpoint-save', durationMs: 5 }),
      event('other', { stage: 'checkpoint-save', durationMs: 9999 }),
    ]);
    expect(data).toMatchObject({
      elapsedMs: 1000,
      modelMs: 900,
      executionMs: 1450,
      networkQueueMs: 150,
      checkpointMs: 5,
      toolStartWaitMs: 100,
    });
    expect(data?.firstOutputMs).toBeUndefined();
    expect(data?.processingMs).toBeUndefined();
    expect(runPerformance(run, [])).toBeUndefined();
  });

  it('同一阶段只构造一次名单，下一次调用仍使用最新授权，诊断保存不包含参数正文', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    core.scheduler.pause();
    const member = bot('检索', ['search_messages']);
    const workspace = core.state.snapshot().workspaces[0];
    const room = core.entities.createConversation({
      name: '检索',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: workspace.id,
    });
    const task = {
      id: 'timing-task',
      botId: member.id,
      conversationId: room.id,
      runIds: [],
      status: 'running',
      goal: '检索',
    } as unknown as Task;
    const run = {
      id: 'timing-run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      createdAt: '',
    } as Run;
    core.state.storage.put('tasks', task);
    core.state.storage.put('runs', run);
    const context = core.tools.context(
      run,
      task,
      member,
      room,
      workspace,
      new AbortController().signal,
    );
    const registry = createToolRegistry();
    const definitions = vi.fn(registry.definitions.bind(registry));
    const runtime = new ToolRuntime(
      core.state,
      { ...registry, definitions },
      core.tasks,
      core.approvals,
      core.memory,
      core.team,
      core.memories,
    );
    try {
      await runtime.execute(
        'search_messages',
        { query: 'private-fixture-content' },
        'one',
        context,
        member,
      );
      expect(definitions).toHaveBeenCalledTimes(1);
      core.entities.saveBot({ ...member, toolNames: [] });
      await expect(
        runtime.execute(
          'search_messages',
          { query: 'private-fixture-content' },
          'two',
          context,
          member,
        ),
      ).rejects.toThrow('未授权');
      expect(definitions).toHaveBeenCalledTimes(2);
      const samples = core.state.storage
        .runEvents(run.id)
        .events.filter((event) => event.data.phase === 'performance');
      expect(samples.map((event) => event.data.status)).toEqual(['succeeded', 'failed']);
      expect(samples[0].data).toMatchObject({
        scope: 'tool',
        callId: 'one',
        durations: {
          authorizationMs: expect.any(Number),
          executionMs: expect.any(Number),
          processingMs: expect.any(Number),
          saveMs: expect.any(Number),
        },
      });
      expect(JSON.stringify(samples)).not.toContain('private-fixture-content');
    } finally {
      await runtime.processes.close();
      await registry.close();
    }
  });
});
