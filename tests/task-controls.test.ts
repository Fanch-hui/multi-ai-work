import { describe, expect, it } from 'vitest';
import type { Artifact, Bot, Conversation, Run, Task } from '../src/domain/types.js';
import type { RunContext } from '../src/domain/provider.js';
import { id, now } from '../src/core/state.js';
import { TaskInputService } from '../src/core/task-inputs.js';
import { eventually, setup } from './core-harness.js';

async function fixture(execute: (context: RunContext) => Promise<{ text: string }> = async () => ({ text: '完成' })) {
  const { core, bot } = await setup(execute);
  core.scheduler.pause();
  const chief = core.entities.saveBot({ ...bot('Chief', ['get_task', 'read_artifact', 'send_task_input', 'stop_task', 'reconcile_task']),
    approvalMode: 'auto', memoryMode: 'off' });
  const member = core.entities.saveBot({ ...bot('制作成员', ['write_artifact']), approvalMode: 'auto', memoryMode: 'off' });
  const room = core.state.storage.get<Conversation>('conversations', core.state.settings().mainConversationId!)!;
  const source = core.tasks.create({ conversationId: room.id, botId: chief.id, goal: '完成材料' });
  const group = core.team.createTaskGroup(source, { name: '制作', goal: '制作材料', memberIds: [member.id] });
  const child = core.tasks.create({ conversationId: group.conversation.id, botId: member.id, parentId: group.task.id, goal: '制作材料' });
  core.tasks.update(group.task, { status: 'waiting_children' });
  core.tasks.update(source, { status: 'waiting_children' });
  const actor = (task: Task, actorBot: Bot, conversation: Conversation) => {
    const run: Run = { id: id(), taskId: task.id, botId: actorBot.id, bindingId: id(), status: 'running',
      configRevision: actorBot.revision, createdAt: now(), requirementVersion: 1 };
    core.state.storage.put('runs', run);
    const current = core.tasks.update(task, { status: 'running', runIds: [run.id] });
    const context = core.tools.context(run, current, actorBot, conversation, core.state.snapshot().workspaces[0], new AbortController().signal);
    return { run, context, task: current,
      tool: (name: string, args: Record<string, unknown>) => core.tools.execute(name, args, id(), context, actorBot) };
  };
  const diagnostic = core.tasks.create({ conversationId: room.id, botId: chief.id, goal: '只读检查' });
  return { core, source, group, child, member, chief, actor, control: actor(diagnostic, chief, room) };
}

describe('主管任务控制与需求版本', () => {
  it.each(['stop_task', 'send_task_input', 'reconcile_task'])('%s 审批期间撤权后不会改变成员任务', async name => {
    const f = await fixture();
    f.core.entities.saveBot({ ...f.chief, approvalMode: 'ask' });
    if (name === 'reconcile_task') f.core.tasks.update(f.child, { status: 'failed', reconciliationRequired: true });
    const before = f.core.state.storage.get<Task>('tasks', f.child.id)!;
    const messages = f.core.state.storage.messages(f.group.conversation.id);
    const inputs = f.core.state.snapshot().taskInputs;
    const executing = f.control.tool(name, { taskId: f.child.id,
      ...(name === 'send_task_input' ? { content: '新增要求' } : name === 'reconcile_task' ? { outcome: 'succeeded' } : {}) });
    await eventually(() => f.core.state.snapshot().approvals.some(item => item.status === 'pending'));
    f.core.entities.saveBot({ ...f.chief, approvalMode: 'ask', toolNames: [] });
    f.core.approvals.resolve(f.core.state.snapshot().approvals.find(item => item.status === 'pending')!.id, true);
    expect(await executing).toMatchObject({ error: expect.stringContaining('未授权') });
    expect(f.core.state.storage.get<Task>('tasks', f.child.id)).toEqual(before);
    expect(f.core.state.storage.messages(f.group.conversation.id)).toEqual(messages);
    expect(f.core.state.snapshot().taskInputs).toEqual(inputs);
    expect(f.core.state.storage.all<{ status: string }>('tool_operations')).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('按当前 run 停止真实运行的成员任务，返回实际终态并保留取消请求时间', async () => {
    let running = false;
    const f = await fixture(async context => {
      running = true;
      context.emit({ type: 'status', data: { phase: 'model-request' } });
      return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    });
    f.core.scheduler.resume();
    await eventually(() => running);
    f.core.scheduler.pause();
    const child = f.core.state.storage.get<Task>('tasks', f.child.id)!;
    const stopped = await f.control.tool('stop_task', { runId: child.runIds[0] });
    expect(stopped).toMatchObject({ taskId: child.id, cancellationRequested: true, stopped: true, status: 'cancelled' });
    expect(f.core.state.storage.get<Run>('runs', child.runIds[0])).toMatchObject({ status: 'cancelled', cancelRequestedAt: expect.any(String) });
    expect(f.core.state.storage.get<Task>('tasks', f.control.task.id)?.status).toBe('running');
  });

  it('引导复用成员任务，确认接收后停止仍保留确认，新成果与需求版本绑定', async () => {
    const f = await fixture();
    const worker = f.actor(f.child, f.member, f.group.conversation);
    const old = await worker.tool('write_artifact', { path: '材料.md', format: 'markdown', content: '初稿' }) as Artifact;
    const before = f.core.state.snapshot().tasks.length;
    const sent = await f.control.tool('send_task_input', { taskId: f.child.id, content: '预算改260元，练习至少30分钟' }) as { messageId: string };
    expect(f.core.state.snapshot().tasks).toHaveLength(before);
    const draft = f.core.state.storage.appendMessage({ id: id(), conversationId: f.group.conversation.id, authorType: 'bot',
      authorBotId: f.member.id, runId: worker.run.id, content: '', artifactIds: [], status: 'draft', createdAt: now() });
    const inputs = new TaskInputService(f.core.state);
    const channel = inputs.forRun(worker.run, worker.context, draft, 0);
    const messages = channel.take();
    expect(messages[0].content).toContain('预算改260元');
    channel.acknowledge!([sent.messageId]);
    inputs.release(worker.run.id);
    expect(f.core.state.snapshot().taskInputs[0]).toMatchObject({ status: 'delivered', requirementVersion: 2, deliveredAt: expect.any(String) });
    expect(inputs.hasPending(f.child.id)).toBe(false);
    const changed = await worker.tool('write_artifact', { path: '新材料.md', format: 'markdown', content: '260元，30分钟' }) as Artifact;
    expect(changed.requirementVersion).toBe(2);
    expect(f.core.state.snapshot().artifacts.find(artifact => artifact.id === old.id)).toMatchObject({ requirementVersion: 1, superseded: true });
    const inspected = await f.core.request('tasks.inspect', { id: f.child.id }) as Task;
    expect(inspected.requirement).toMatchObject({ version: 2, updates: [{ messageId: sent.messageId }] });
  });

  it('读取已停止成员的部分成果后可在来源主对话核查，其他主对话保持隔离', async () => {
    const f = await fixture();
    const worker = f.actor(f.child, f.member, f.group.conversation);
    const artifact = await worker.tool('write_artifact', { path: '部分成果.md', format: 'markdown', content: '可用成果' }) as Artifact;
    f.core.tasks.update(worker.task, { status: 'cancelled' });
    const inspected = await f.control.tool('get_task', { taskId: f.child.id }) as Task;
    expect(inspected.artifactIds).toContain(artifact.id);
    expect(await f.control.tool('read_artifact', { artifactId: artifact.id })).toMatchObject({ content: '可用成果' });
    const other = f.core.team.createChiefConversation('独立主对话');
    const unrelated = f.core.tasks.create({ conversationId: other.id, botId: f.chief.id, goal: '独立检查' });
    const actor = f.actor(unrelated, f.chief, other);
    expect(await actor.tool('get_task', { taskId: f.child.id })).toMatchObject({ error: expect.stringContaining('未授权') });
    expect(await actor.tool('read_artifact', { artifactId: artifact.id })).toMatchObject({ error: expect.stringContaining('未授权') });
  });

  it('只读检查报告真实活动和检查点，不刷新模型活动时间或恢复任务', async () => {
    const f = await fixture();
    const worker = f.actor(f.child, f.member, f.group.conversation);
    const at = '2026-10-14T12:46:56.000Z';
    f.core.state.storage.event({ id: id(), runId: worker.run.id, type: 'status', data: { phase: 'model-request' }, createdAt: at });
    f.core.state.storage.put('context_checkpoints', { id: 'checkpoint', bindingId: worker.run.bindingId, generation: 1,
      throughSequence: 0, content: '摘要', sourceMessageIds: [], estimatedTokens: 1, createdAt: at });
    f.core.tasks.update(worker.task, { updatedAt: now() });
    const inspected = await f.core.request('tasks.inspect', { id: f.child.id }) as Task;
    expect(inspected.activity).toMatchObject({ phase: 'model', lastModelActivityAt: at, lastActivityAt: at, checkpointId: 'checkpoint', waitingFor: '模型响应' });
    expect(f.core.state.storage.get<Task>('tasks', f.child.id)?.runIds).toEqual([worker.run.id]);
  });
});
