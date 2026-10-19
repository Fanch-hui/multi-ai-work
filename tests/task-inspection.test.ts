import { describe, expect, it } from 'vitest';
import type { Task } from '../src/domain/types.js';
import { eventually, setup } from './core-harness.js';

describe('主管读取成员当前执行状态', () => {
  it('get_task返回刚失败成员的最新运行与错误，而非只提供旧汇总', async () => {
    let memberId = '',
      inspected = false,
      rounds = 0;
    const { core, connection, bot } = await setup(async (context) => {
      if (context.bot.id === memberId) throw new Error('模型请求失败（HTTP 507）');
      if (++rounds === 1) {
        const child = (await context.executeTool(
          'delegate_task',
          { botId: memberId, goal: '制作成果', expectedOutput: '文件' },
          'delegate',
        )) as Task;
        await eventually(
          () => core.state.storage.get<Task>('tasks', child.id)?.status === 'failed',
        );
        const result = (await context.executeTool('get_task', {}, 'inspect')) as {
          children: {
            id: string;
            botName: string;
            status: string;
            error: string;
            latestRun: { status: string; error: string };
          }[];
        };
        expect(result.children).toHaveLength(1);
        expect(result.children[0]).toMatchObject({
          id: child.id,
          botName: '制作成员',
          status: 'failed',
          error: '模型请求失败（HTTP 507）',
          latestRun: { status: 'failed', error: '模型请求失败（HTTP 507）' },
        });
        inspected = true;
      }
      return { text: '保留成果并汇报失败' };
    });
    core.scheduler.pause();
    core.state.storage.put('connections', { ...connection, concurrency: 2, status: 'ready' });
    const chief = bot('Chief', ['delegate_task', 'get_task']);
    memberId = bot('制作成员').id;
    const room = core.entities.createConversation({
      name: '协作',
      kind: 'group',
      chiefId: chief.id,
      memberIds: [chief.id, memberId],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const parent = core.tasks.create({ conversationId: room.id, botId: chief.id, goal: '统筹' });
    core.scheduler.resume();
    await eventually(
      () => core.state.storage.get<Task>('tasks', parent.id)?.status === 'completed',
    );
    expect(inspected).toBe(true);
  });
});
