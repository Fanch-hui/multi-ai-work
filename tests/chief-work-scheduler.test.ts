import { describe, expect, it } from 'vitest';
import type { Connection, Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

async function fixture(limit: number) {
  const started = new Set<string>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { core, connection, bot } = await setup(async (context) => {
    started.add(context.binding.conversationId);
    await Promise.race([
      gate,
      new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
    ]);
    return { text: '完成' };
  });
  core.scheduler.pause();
  bot('Chief');
  core.state.storage.put('connections', {
    ...core.state.storage.get<Connection>('connections', connection.id)!,
    concurrency: limit,
  });
  core.state.storage.setMetadata('settings', { ...core.state.settings(), maxActiveRuns: limit });
  const main = core.chief.contexts.main();
  const work = (title: string) => {
    const context = core.chief.contexts.create({ title, kind: 'work' });
    const task = core.tasks.create({
      conversationId: context.conversationId,
      botId: core.state.settings().mainBotId!,
      goal: title,
    });
    return { context, task };
  };
  return { core, main, work, started, release };
}

describe('管家前台调度', () => {
  it('后台保留一个前台名额，用户发消息时仍能启动主对话', async () => {
    const f = await fixture(2);
    const a = f.work('报告 A');
    const b = f.work('报告 B');
    f.core.scheduler.resume();
    await eventually(() => f.started.has(a.context.conversationId));
    expect(f.started.has(b.context.conversationId)).toBe(false);
    expect(f.core.state.snapshot().tasks.find((task) => task.id === b.task.id)?.queueReason).toBe(
      'global_limit',
    );
    const mainTask = f.core.tasks.create({
      conversationId: f.main.room.id,
      botId: f.core.state.settings().mainBotId!,
      goal: '你好',
    });
    await eventually(() => f.started.has(f.main.room.id));
    expect(f.core.state.storage.get<Task>('tasks', mainTask.id)?.status).toBe('running');
    expect(f.core.state.storage.get<Task>('tasks', a.task.id)?.status).toBe('running');
    f.release();
    await eventually(() =>
      [a.task, b.task, mainTask].every(
        (task) => f.core.state.storage.get<Task>('tasks', task.id)?.status === 'completed',
      ),
    );
  });

  it('同批主对话优先，额度为一时后续后台任务顺序执行', async () => {
    const f = await fixture(1);
    const work = f.work('报告');
    const mainTask = f.core.tasks.create({
      conversationId: f.main.room.id,
      botId: f.core.state.settings().mainBotId!,
      goal: '你好',
    });
    f.core.scheduler.resume();
    await eventually(() => f.started.has(f.main.room.id));
    expect(f.started.has(work.context.conversationId)).toBe(false);
    f.release();
    await eventually(
      () => f.core.state.storage.get<Task>('tasks', work.task.id)?.status === 'completed',
    );
    expect(f.core.state.storage.get<Task>('tasks', mainTask.id)?.status).toBe('completed');
  });
});
