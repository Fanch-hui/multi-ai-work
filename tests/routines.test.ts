import { describe, expect, it } from 'vitest';
import type { Routine, RoutineOccurrence } from '../src/domain/routines.js';
import type { Artifact, Task } from '../src/domain/types.js';
import { RoutineService } from '../src/core/routines.js';
import { importAttachmentBytes } from '../src/core/attachments.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot, connection } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  await core.request('chief.configure', { input: { connectionId: connection.id, model: 'test' } });
  const clock = { value: '2026-10-23T08:00:00.000Z' };
  const service = new RoutineService(core.state, core.tasks, core.team, () => clock.value);
  const workspaceId = core.state.snapshot().workspaces[0]!.id;
  const input = {
    name: '每日整理',
    botId: core.state.settings().mainBotId!,
    workspaceId,
    goal: '整理资料',
    expectedOutput: '报告',
    inputArtifactIds: [] as string[],
    schedule: { kind: 'daily' as const, time: '09:00' },
    timeZone: 'UTC',
  };
  const save = (fields = input) =>
    service.request('routines.save', { input: fields }) as Promise<Routine>;
  return { core, bot, service, clock, input, save };
}

describe('例行工作', () => {
  it('使用固定专属会话并保持首页；定时任务事务幂等且没有用户消息', async () => {
    const { core, service, clock, save } = await fixture();
    const home = core.state.settings().mainConversationId;
    const routine = await save();
    expect(routine.conversationId).not.toBe(home);
    expect(core.state.settings().mainConversationId).toBe(home);
    clock.value = '2026-10-23T09:00:00.000Z';
    service.tick();
    service.tick();
    const history = service.request('routines.history', { id: routine.id }) as RoutineOccurrence[];
    expect(history).toHaveLength(1);
    const task = core.state.storage.get<Task>('tasks', history[0]!.taskId!)!;
    expect(task.trigger).toMatchObject({ routineId: routine.id, automatic: true });
    expect(task.kind).toBeUndefined();
    expect(core.state.storage.messages(routine.conversationId)).toHaveLength(0);
    const restarted = new RoutineService(core.state, core.tasks, core.team, () => clock.value);
    restarted.tick();
    expect(service.request('routines.history', { id: routine.id })).toHaveLength(1);
  });

  it('管家工作切段后例行执行使用当前段并保留指定资料授权', async () => {
    const { core, service, input, save } = await fixture();
    const attachment = await importAttachmentBytes(
      core.state,
      core.state.settings().mainConversationId!,
      '例行资料.txt',
      'text/plain',
      Buffer.from('例行输入').toString('base64'),
    );
    const routine = await save({ ...input, inputArtifactIds: [attachment.id] });
    const context = core.chief.contexts.list().find((item) => item.routineId === routine.id)!;
    const next = core.chief.contexts.rotate(
      context.id,
      '继续每日整理',
      [],
      routine.inputArtifactIds,
    );
    expect(next.conversationId).not.toBe(routine.conversationId);
    const occurrence = service.request('routines.runNow', {
      id: routine.id,
      requestId: 'after-context-switch',
    }) as RoutineOccurrence;
    expect(core.state.storage.get<Task>('tasks', occurrence.taskId!)).toMatchObject({
      conversationId: next.conversationId,
      inputArtifactIds: routine.inputArtifactIds,
    });
    expect(service.request('routines.get', { id: routine.id })).toMatchObject({
      conversationId: next.conversationId,
    });
    expect(
      core.state.storage.metadata<string[]>(`chief-artifact-grants:${next.conversationId}`),
    ).toEqual(expect.arrayContaining(routine.inputArtifactIds));
    expect(core.state.settings().mainConversationId).toBe(context.homeConversationId);
  });

  it('运行中的完整任务树阻止重叠，完成后合并补跑最新一次', async () => {
    const { core, service, clock, save } = await fixture();
    const routine = await save();
    clock.value = '2026-10-23T09:00:00.000Z';
    service.tick();
    const root = core.state.storage.all<Task>('tasks')[0]!;
    core.state.storage.put('tasks', { ...root, status: 'completed' });
    core.state.storage.put('tasks', {
      ...root,
      id: 'active-child',
      parentId: root.id,
      status: 'running',
    });
    clock.value = '2026-10-26T10:00:00.000Z';
    service.tick();
    expect(core.state.storage.all<RoutineOccurrence>('routine_occurrences')).toHaveLength(1);
    expect(service.request('routines.get', { id: routine.id })).toMatchObject({
      pendingAt: '2026-10-26T09:00:00.000Z',
    });
    core.state.storage.put('tasks', {
      ...root,
      id: 'active-child',
      parentId: root.id,
      status: 'completed',
    });
    service.tick();
    const history = core.state.storage.all<RoutineOccurrence>('routine_occurrences');
    expect(history).toHaveLength(2);
    expect(history[1]!.scheduledAt).toBe('2026-10-26T09:00:00.000Z');
  });

  it('支持普通成员，手动执行稳定去重，暂停不停止当前任务', async () => {
    const { core, bot, service, input, save } = await fixture();
    const member = bot('资料员');
    const routine = await save({ ...input, botId: member.id });
    const first = service.request('routines.runNow', { id: routine.id, requestId: 'manual' });
    expect(service.request('routines.runNow', { id: routine.id, requestId: 'manual' })).toEqual(
      first,
    );
    expect(() =>
      service.request('routines.runNow', { id: routine.id, requestId: 'other' }),
    ).toThrow('仍在执行');
    service.request('routines.setEnabled', { id: routine.id, enabled: false });
    expect(core.state.storage.all<Task>('tasks')[0]).toMatchObject({
      botId: member.id,
      status: 'queued',
    });
  });

  it('跳过策略、维护阻止触发、备份恢复暂停', async () => {
    const { core, service, input, clock, save } = await fixture();
    const routine = await save({ ...input, missedRunPolicy: 'skip' } as typeof input);
    clock.value = '2026-10-26T10:00:00.000Z';
    service.start(() => false);
    service.tick();
    service.close();
    expect(core.state.storage.all<Task>('tasks')).toHaveLength(0);
    service.start(() => true);
    service.close();
    expect(service.request('routines.history', { id: routine.id })).toMatchObject([
      { reason: '已按设置跳过错过的执行' },
    ]);
    service.pauseRestored();
    expect(service.request('routines.get', { id: routine.id })).toMatchObject({ enabled: false });
  });

  it('输入转交保持共享正文与原归属，原资料删除后专属资料仍可使用', async () => {
    const { core, service, input, save } = await fixture();
    const attachment = await importAttachmentBytes(
      core.state,
      core.state.settings().mainConversationId!,
      '资料.txt',
      'text/plain',
      Buffer.from('输入正文').toString('base64'),
    );
    const routine = await save({ ...input, inputArtifactIds: [attachment.id] });
    const copied = core.state.storage.get<Artifact>('artifacts', routine.inputArtifactIds[0]!)!;
    expect(copied).toMatchObject({
      conversationId: routine.conversationId,
      objectHash: attachment.objectHash,
    });
    expect(copied.id).not.toBe(attachment.id);
    expect(copied.path).not.toBe(attachment.path);
    core.state.storage.delete('artifacts', attachment.id);
    const occurrence = service.request('routines.runNow', {
      id: routine.id,
      requestId: 'files',
    }) as RoutineOccurrence;
    expect(core.state.storage.get<Task>('tasks', occurrence.taskId!)?.inputArtifactIds).toEqual([
      copied.id,
    ]);
  });

  it('资料丢失或负责人失效暂停并保存原因，一次性工作只启动一次', async () => {
    const { core, service, clock, input, save } = await fixture();
    const routine = await save({
      ...input,
      schedule: { kind: 'once', at: '2026-10-23T09:00:00Z' },
    } as unknown as typeof input);
    clock.value = '2026-10-23T09:00:00.000Z';
    service.tick();
    expect(service.request('routines.get', { id: routine.id })).toMatchObject({ enabled: false });
    const second = await save();
    core.state.storage.delete('bots', input.botId);
    clock.value = '2026-10-24T09:00:00.000Z';
    service.tick();
    expect(service.request('routines.get', { id: second.id })).toMatchObject({
      enabled: false,
      error: '例行工作负责人不存在',
    });
  });
});
