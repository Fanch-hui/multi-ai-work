import { describe, expect, it, vi } from 'vitest';
import type { Run, SessionBinding, Task, UserQuestion } from '../src/domain/types.js';
import { recoverSchedulerState } from '../src/core/scheduler-recovery.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot: createBot, connection } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const bot = createBot('恢复成员');
  const workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({
    name: '恢复会话',
    kind: 'private',
    memberIds: [bot.id],
    workspaceId: workspace.id,
  });
  const task = core.tasks.create({ conversationId: room.id, botId: bot.id, goal: '继续处理' });
  const binding: SessionBinding = {
    id: id(),
    botId: bot.id,
    conversationId: room.id,
    connectionId: connection.id,
    generation: 2,
    configRevision: bot.revision,
    connectionRevision: connection.revision,
    workspaceId: workspace.id,
    nativeSessionId: 'native-session',
    lastDeliveredSequence: 9,
    memoryVersions: { memory: 1 },
  };
  const run: Run = {
    id: id(),
    taskId: task.id,
    botId: bot.id,
    bindingId: binding.id,
    configRevision: bot.revision,
    status: 'running',
    createdAt: now(),
  };
  core.state.storage.put('session_bindings', binding);
  core.state.storage.put('runs', run);
  core.tasks.update(task, { status: 'running', runIds: [run.id] });
  return { core, storage: core.state.storage, task, run, binding, room, bot };
}

describe('调度启动恢复', () => {
  it('保留待回答问题并更新原生绑定，未知操作仍要求对账', async () => {
    const { core, storage, task, run, binding, room, bot } = await fixture();
    const question: UserQuestion = {
      id: id(),
      taskId: task.id,
      runId: run.id,
      botId: bot.id,
      conversationId: room.id,
      question: '选择交付格式',
      status: 'pending',
      createdAt: now(),
    };
    storage.put('questions', question);
    storage.put('tool_operations', {
      id: 'dispatched-operation',
      runId: run.id,
      status: 'dispatched',
    });
    storage.put('tool_operations', { id: 'prepared-operation', runId: run.id, status: 'prepared' });

    recoverSchedulerState(core.state);

    expect(storage.get<Run>('runs', run.id)?.status).toBe('waiting_input');
    expect(storage.get<Task>('tasks', task.id)).toMatchObject({
      status: 'interrupted',
      reconciliationRequired: true,
    });
    expect(storage.get<SessionBinding>('session_bindings', binding.id)).toMatchObject({
      generation: 3,
      lastDeliveredSequence: 0,
    });
    expect(
      storage.get<SessionBinding>('session_bindings', binding.id)?.nativeSessionId,
    ).toBeUndefined();
    expect(storage.get<UserQuestion>('questions', question.id)).toEqual(question);
    expect(storage.get('tool_operations', 'dispatched-operation')).toMatchObject({
      status: 'unknown',
    });
    expect(storage.get('tool_operations', 'prepared-operation')).toMatchObject({
      status: 'failed',
    });
  });

  it('恢复写入失败时传播错误，并回滚任务、运行和操作状态', async () => {
    const { core, storage, task, run } = await fixture();
    storage.put('compactions', { id: 'compaction', status: 'started' });
    const beforeTask = storage.get<Task>('tasks', task.id);
    const beforeRun = storage.get<Run>('runs', run.id);
    const put = storage.put.bind(storage);
    const write = vi.spyOn(storage, 'put').mockImplementation((table, value) => {
      if (table === 'compactions') throw new Error('恢复写入失败');
      return put(table, value);
    });

    expect(() => recoverSchedulerState(core.state)).toThrow('恢复写入失败');
    write.mockRestore();

    expect(storage.get<Task>('tasks', task.id)).toEqual(beforeTask);
    expect(storage.get<Run>('runs', run.id)).toEqual(beforeRun);
    expect(storage.get('compactions', 'compaction')).toMatchObject({ status: 'started' });
  });
});
