import { describe, expect, it } from 'vitest';
import type { RunEventPage } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('Core 完整运行记录', () => {
  it('持久摘要和分页不受其他运行或大量文本事件影响', async () => {
    const { core, bot } = await setup(async (context) => {
      for (let step = 1; step <= 6; step++) {
        context.emit({ type: 'status', data: { phase: 'model-request', step } });
        for (let i = 0; i < 60; i++) context.emit({ type: 'text', data: { delta: 'a' } });
        context.emit({ type: 'status', data: { phase: 'model-response', step, durationMs: 20 } });
      }
      context.emit({
        type: 'usage',
        data: { source: 'reported', inputTokens: 120, outputTokens: 360 },
      });
      return { text: '已完成' };
    });
    const member = bot('助手');
    const room = core.entities.createConversation({
      name: '记录',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    core.tasks.send({ conversationId: room.id, content: '执行工作' });
    await eventually(() => core.state.snapshot().runs[0]?.status === 'completed');
    const run = core.state.snapshot().runs[0];
    expect(core.state.snapshot().events.every((event) => event.type !== 'text')).toBe(true);
    expect(
      core.state.snapshot().events.filter((event) => event.data.phase === 'model-request'),
    ).toHaveLength(6);
    expect(run.modelRequestCount).toBe(6);
    expect(run.modelDurationMs).toBe(120);
    expect(run.confirmedUsage).toMatchObject({ source: 'reported', outputTokens: 360 });
    expect(run.contextUsage?.owner).toBe('app');
    const latest = (await core.request('runs.events', { id: run.id, limit: 5 })) as RunEventPage;
    const earlier = (await core.request('runs.events', {
      id: run.id,
      limit: 100,
      cursor: latest.nextCursor,
    })) as RunEventPage;
    expect(
      [...earlier.events, ...latest.events].filter((event) => event.data.phase === 'model-request'),
    ).toHaveLength(6);
    expect(
      [...earlier.events, ...latest.events].every(
        (event) => event.type !== 'text' && event.runId === run.id,
      ),
    ).toBe(true);
    await expect(core.request('runs.events', { id: 'missing' })).rejects.toThrow('不存在');
  });

  it('失败保留已确认部分用量及失败请求耗时，同时完整用量保持未知', async () => {
    const { core, bot } = await setup(async (context) => {
      context.emit({ type: 'status', data: { phase: 'model-request', step: 1 } });
      context.emit({
        type: 'usage',
        data: { source: 'reported', inputTokens: 10, outputTokens: 5 },
      });
      context.emit({ type: 'status', data: { phase: 'model-response', step: 1, durationMs: 100 } });
      context.emit({ type: 'status', data: { phase: 'model-request', step: 2 } });
      context.emit({ type: 'status', data: { phase: 'model-error', step: 2, durationMs: 50 } });
      throw new Error('模型服务繁忙');
    });
    const member = bot('助手');
    const room = core.entities.createConversation({
      name: '失败记录',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    core.tasks.send({ conversationId: room.id, content: '执行工作' });
    await eventually(() => core.state.snapshot().runs[0]?.status === 'failed');
    const run = core.state.snapshot().runs[0];
    expect(run.usage?.source).toBe('unknown');
    expect(run.confirmedUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(run.modelRequestCount).toBe(2);
    expect(run.modelDurationMs).toBe(150);
  });
});
