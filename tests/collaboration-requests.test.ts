import { describe, expect, it } from 'vitest';
import type { Bot, Run, Task } from '../src/domain/types.js';
import type { CollaborationRequest } from '../src/domain/collaboration.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const chief = bot('Chief', ['delegate_task', 'resolve_collaboration']);
  const researcher = bot('研究员', ['request_collaboration']);
  const writer = bot('写作者');
  for (const member of [chief, researcher, writer])
    core.state.storage.put<Bot>('bots', { ...member, approvalMode: 'auto' });
  const workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({
    name: '协作群',
    kind: 'group',
    chiefId: chief.id,
    memberIds: [chief.id, researcher.id, writer.id],
    workspaceId: workspace.id,
  });
  const parent = core.tasks.create({ conversationId: room.id, botId: chief.id, goal: '完成报告' });
  const source = core.tasks.create({
    conversationId: room.id,
    botId: researcher.id,
    parentId: parent.id,
    goal: '研究资料',
  });
  function context(task: Task, member: Bot, runId: string) {
    const run: Run = {
      id: runId,
      taskId: task.id,
      botId: member.id,
      bindingId: 'binding',
      status: 'running',
      configRevision: member.revision,
      createdAt: new Date().toISOString(),
    };
    core.state.storage.put('runs', run);
    return {
      ...core.tools.context(run, task, member, room, workspace, new AbortController().signal),
      callId: 'call',
    };
  }
  return {
    core,
    chief,
    researcher,
    writer,
    room,
    parent,
    source,
    memberContext: context(source, researcher, 'research-run'),
    chiefContext: context(parent, chief, 'chief-run'),
  };
}
describe('主管统筹的异步成员交接', () => {
  it('请求幂等、主管派发真实任务、结果回到请求成员', async () => {
    const f = await fixture();
    const args = { targetBotId: f.writer.id, goal: '根据研究写摘要' };
    const request = await f.core.work.collaboration.create(args, f.memberContext);
    expect((await f.core.work.collaboration.create(args, f.memberContext)).id).toBe(request.id);
    const assigned = await f.core.work.collaboration.resolve(
      { id: request.id, action: 'accept' },
      f.chiefContext,
    );
    expect(assigned.status).toBe('assigned');
    const task = f.core.state.storage.get<Task>('tasks', assigned.targetTaskId!)!;
    expect(task).toMatchObject({ botId: f.writer.id, parentId: f.parent.id, goal: args.goal });
    f.core.tasks.update(task, { status: 'completed', result: '摘要已完成' });
    expect(
      f.core.state.storage.get<CollaborationRequest>('collaboration_requests', request.id),
    ).toMatchObject({ status: 'completed', replyTaskId: f.source.id });
    expect(f.core.state.storage.byField('deliveries', 'taskId', f.source.id)).toHaveLength(1);
  });
  it('普通成员不能批准协作，私聊不能暗中引入主管', async () => {
    const f = await fixture();
    const request = await f.core.work.collaboration.create(
      { targetBotId: f.writer.id, goal: '写摘要' },
      f.memberContext,
    );
    await expect(
      f.core.work.collaboration.resolve({ id: request.id, action: 'accept' }, f.memberContext),
    ).rejects.toThrow('主管');
    const room = f.core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [f.researcher.id],
      workspaceId: f.room.workspaceId,
    });
    await expect(
      f.core.work.collaboration.create(
        { targetBotId: f.writer.id, goal: '写摘要' },
        { ...f.memberContext, conversation: room },
      ),
    ).rejects.toThrow('当前团队群');
  });
  it('恢复备份等待用户继续协作任务，随后完成才回传', async () => {
    const f = await fixture();
    const request = await f.core.work.collaboration.create(
      { targetBotId: f.writer.id, goal: '写摘要' },
      f.memberContext,
    );
    const assigned = await f.core.work.collaboration.resolve(
      { id: request.id, action: 'accept' },
      f.chiefContext,
    );
    const backup = (await f.core.request('backup.create')) as { path: string };
    const count = f.core.state.storage.all('tasks').length;
    await f.core.request('backup.restore', { path: backup.path });
    f.core.scheduler.pause();
    expect(f.core.state.storage.all('tasks')).toHaveLength(count);
    expect(
      f.core.state.storage.get<CollaborationRequest>('collaboration_requests', request.id),
    ).toMatchObject({ status: 'assigned', awaitingTaskResume: true });
    const task = f.core.state.storage.get<Task>('tasks', assigned.targetTaskId!)!;
    expect(task.status).toBe('interrupted');
    f.core.tasks.update(task, { status: 'completed', result: '继续后完成' });
    const completed = f.core.state.storage.get<CollaborationRequest>(
      'collaboration_requests',
      request.id,
    )!;
    expect(completed).toMatchObject({ status: 'completed', feedback: '继续后完成' });
    expect(completed.replyTaskId).toBeTruthy();
    expect(f.core.state.storage.all('tasks')).toHaveLength(count + 1);
  });
});
