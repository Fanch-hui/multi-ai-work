import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run, Task } from '../src/domain/types.js';
import type { TaskWait } from '../src/domain/task-wait.js';
import { TaskWaitService } from '../src/core/task-waits.js';
import { recoverSchedulerState } from '../src/core/scheduler-recovery.js';
import { eventually, setup } from './core-harness.js';

const trigger = {
  type: 'routine' as const,
  routineId: 'routine',
  occurrenceId: 'occurrence',
  automatic: true,
};

describe('持久任务等待', () => {
  it('无人审批保存等待并释放名额，继续后正式审批且保留来源', async () => {
    let rounds = 0;
    const { core, bot } = await setup(async (context) => {
      rounds++;
      const task = core.state.storage.get<Task>(
        'tasks',
        core.state.storage.get<Run>('runs', context.runId)!.taskId,
      )!;
      if (rounds === 1) core.state.storage.put('tasks', { ...task, trigger });
      await context.executeTool('read_file', { path: 'result.txt' }, `read-${rounds}`);
      const result = await context.executeTool(
        'write_file',
        { path: 'result.txt', content: '交付内容' },
        `write-${rounds}`,
      );
      if (rounds === 1) {
        expect(result).toMatchObject({ waitingForInput: true });
        expect(context.isWaitingForInput?.()).toBe(true);
        return { text: '' };
      }
      expect(context.prompt).toContain('用户已选择继续任务');
      return { text: '完成交付' };
    });
    const member = bot('助手', ['write_file', 'read_file']);
    const workspace = core.state.snapshot().workspaces[0];
    await writeFile(join(workspace.path, 'result.txt'), '初稿');
    const room = core.entities.createConversation({
      name: '例行工作',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: workspace.id,
    });
    const sent = core.tasks.send({ conversationId: room.id, content: '写文件' });
    await eventually(
      () =>
        !core.scheduler.hasActive() &&
        core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'waiting_input',
    );
    expect(core.state.snapshot().approvals).toHaveLength(0);
    expect(core.state.snapshot().questions).toHaveLength(0);
    expect(await readFile(join(workspace.path, 'result.txt'), 'utf8')).toBe('初稿');
    const waits = new TaskWaitService(core.state);
    const wait = core.state.storage.all<TaskWait>('task_waits')[0];
    expect(wait.kind).toBe('approval');
    waits.resume(wait.id);
    expect(
      core.state.storage.messages(room.id).find((message) => message.authorType === 'system')
        ?.content,
    ).toContain('重新请求具体操作的审批');
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({
      id: sent.taskIds[0],
      interactive: true,
      trigger,
    });
    await eventually(() => core.state.snapshot().approvals[0]?.status === 'pending');
    expect(rounds).toBe(2);
    const approval = core.state.snapshot().approvals[0];
    core.approvals.resolve(approval.id, true);
    await eventually(
      () => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed',
    );
    expect(await readFile(join(workspace.path, 'result.txt'), 'utf8')).toBe('交付内容');
  });

  it('资源等待恢复不变更交互模式，取消后禁止继续', async () => {
    const { core, bot } = await setup(async () => ({ text: '完成' }));
    const member = bot('助手');
    const room = core.entities.createConversation({
      name: '浏览器工作',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const task: Task = {
      requestId: 'wait-request',
      depth: 0,
      id: 'task',
      conversationId: room.id,
      botId: member.id,
      goal: '浏览器工作',
      expectedOutput: '',
      status: 'running',
      runIds: ['run'],
      dependencyIds: [],
      artifactIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      trigger,
    };
    const run: Run = {
      id: 'run',
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      configRevision: member.revision,
      createdAt: new Date().toISOString(),
    };
    core.state.storage.put('tasks', task);
    core.state.storage.put('runs', run);
    const waits = new TaskWaitService(core.state);
    const context = { runId: run.id, task, botId: member.id, conversation: room };
    const wait = waits.create(context, {
      kind: 'browser-resource',
      summary: '等待浏览器',
      resourceId: 'profile',
    });
    expect(waits.create(context, { kind: 'browser-handoff', summary: '重复等待' }).id).toBe(
      wait.id,
    );
    recoverSchedulerState(core.state);
    expect(core.state.storage.get<Run>('runs', run.id)?.status).toBe('waiting_input');
    waits.resourceAvailable(wait.id);
    expect(core.state.storage.get<Task>('tasks', task.id)).toMatchObject({
      status: 'queued',
      trigger,
    });
    expect(core.state.storage.get<Task>('tasks', task.id)?.interactive).toBeUndefined();
    expect(waits.forRun(run.id)?.status).toBe('resumed');
    core.state.storage.put('runs', { ...run, id: 'cancel-run', endedAt: new Date().toISOString() });
    const cancelled = waits.create(
      { ...context, runId: 'cancel-run' },
      { kind: 'approval', summary: '等待审批' },
    );
    waits.cancelTask(task.id);
    expect(() => waits.resume(cancelled.id)).toThrow('已取消');
  });
});
