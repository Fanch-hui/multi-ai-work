import { afterEach, describe, expect, it } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerTaskArtifact } from '../src/core/artifact-registration.js';
import { artifactVersionKey } from '../src/domain/artifact-versions.js';
import { TaskPlanService } from '../src/core/task-plans.js';
import type { Conversation, Run, Task, Workspace } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { ChiefWorkService } from '../src/core/chief-work-service.js';
import { scopedTask } from '../src/core/task-access.js';
import { id, now } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

const services: ChiefWorkService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.closeReports();
});
async function fixture() {
  const { core, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const chief = core.entities.saveBot({
    ...bot('Chief', [
      'start_work',
      'list_work',
      'get_task',
      'read_artifact',
      'send_task_input',
      'stop_task',
    ]),
    approvalMode: 'auto',
    memoryMode: 'off',
  });
  const main = core.chief.contexts.main();
  const message = core.state.storage.appendMessage({
    id: id(),
    conversationId: main.room.id,
    authorType: 'user',
    content: '制作报告 A，同时制作报告 B',
    artifactIds: [],
    status: 'committed',
    createdAt: now(),
  });
  const task = core.tasks.create({
    conversationId: main.room.id,
    botId: chief.id,
    goal: message.content,
    sourceMessageId: message.id,
  });
  const run: Run = {
    id: id(),
    taskId: task.id,
    botId: chief.id,
    bindingId: id(),
    status: 'running',
    configRevision: chief.revision,
    createdAt: now(),
  };
  core.state.storage.put('runs', run);
  const current = core.tasks.update(task, { status: 'running', runIds: [run.id] });
  const workspace = core.state.storage.get<Workspace>('workspaces', main.room.workspaceId)!;
  const context: ToolExecutionContext = {
    ...core.tools.context(run, current, chief, main.room, workspace, new AbortController().signal),
    callId: 'start-a',
  };
  const service = new ChiefWorkService(core.state, core.tasks, core.chief.contexts);
  services.push(service);
  return { core, chief, main, task: current, context, service, message };
}

describe('管家独立后台工作', () => {
  it('A 与 B 使用独立会话，创建幂等，主任务不等待后台子任务', async () => {
    const f = await fixture();
    const first = f.service.start({ goal: '制作报告 A' }, f.context);
    expect(f.service.start({ goal: '制作报告 A' }, f.context)).toEqual(first);
    const next = f.service.start({ goal: '制作报告 B' }, { ...f.context, callId: 'start-b' });
    expect(first.workId).not.toBe(next.workId);
    expect(first.conversationId).not.toBe(next.conversationId);
    expect(f.core.state.storage.get<Task>('tasks', first.taskId)).toMatchObject({
      status: 'queued',
    });
    expect(f.core.state.storage.get<Task>('tasks', first.taskId)?.parentId).toBeUndefined();
    expect(f.core.state.storage.get<Task>('tasks', first.taskId)?.kind).toBeUndefined();
    expect(f.core.state.storage.get<Task>('tasks', f.task.id)?.status).toBe('running');
    expect(f.service.list(f.context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workId: first.workId, taskId: first.taskId, status: 'queued' }),
        expect.objectContaining({ workId: next.workId, taskId: next.taskId, status: 'queued' }),
      ]),
    );
  });

  it('活动工作收到自己的补充，结束后续做创建关联新任务并保留工作归属', async () => {
    const f = await fixture();
    const first = f.service.start({ goal: '制作报告 A' }, f.context);
    const supplement = f.service.start(
      { workId: first.workId, goal: '增加结论' },
      { ...f.context, callId: 'supplement' },
    );
    expect(supplement).toEqual(first);
    const inputs = f.core.state.storage.byField<{ messageId: string }>(
      'deliveries',
      'taskId',
      first.taskId,
    );
    expect(inputs).toHaveLength(1);
    expect(f.core.state.storage.getMessage(inputs[0].messageId)).toMatchObject({
      conversationId: first.conversationId,
      content: '增加结论',
    });
    const original = f.core.state.storage.get<Task>('tasks', first.taskId)!;
    f.core.tasks.update(original, { status: 'completed', result: '报告 A 已完成' });
    const continued = f.service.start(
      { workId: first.workId, goal: '修订报告 A' },
      { ...f.context, callId: 'continue' },
    );
    expect(continued.workId).toBe(first.workId);
    expect(continued.taskId).not.toBe(first.taskId);
    expect(f.core.state.storage.get<Task>('tasks', continued.taskId)).toMatchObject({
      reworkOfTaskId: first.taskId,
      status: 'queued',
    });
    expect(f.core.state.storage.get<Task>('tasks', continued.taskId)?.parentId).toBeUndefined();
    expect(f.core.state.storage.get<Task>('tasks', first.taskId)?.status).toBe('completed');
  });

  it('跨段续做保留原成果输入和版本，不同工作同名文件分别保存', async () => {
    const f = await fixture();
    const first = f.service.start({ goal: '制作报告 A' }, f.context);
    const s = f.core.state.storage;
    const file = join(f.context.workspace.path, 'report.md');
    const publish = async (taskId: string, content: string, previousArtifactId?: string) => {
      const task = s.get<Task>('tasks', taskId)!;
      const room = s.get<Conversation>('conversations', task.conversationId)!;
      await writeFile(file, content);
      return registerTaskArtifact(
        f.core.state,
        {
          path: file,
          workingPath: file,
          name: 'report.md',
          mimeType: 'text/markdown',
          sha256: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
          conversationId: room.id,
          purpose: 'deliverable',
          previousArtifactId,
        },
        task,
        f.chief,
        room,
        s.get<Run>('runs', f.task.runIds[0])!,
      );
    };
    const original = await publish(first.taskId, '第一版');
    const old = s.get<Task>('tasks', first.taskId)!;
    f.core.tasks.update(old, { status: 'completed', result: '第一版完成' });
    const reference = f.core.chief.contexts.create({
      kind: 'history',
      legacyConversationId: first.conversationId,
      legacyTaskId: old.id,
    });
    expect(s.byField<Task>('tasks', 'conversationId', reference.conversationId)).toEqual([]);
    const viaReference = f.service.start(
      { workId: reference.id, goal: '依据旧记录修订' },
      { ...f.context, callId: 'legacy-reference' },
    );
    const linked = s.get<Task>('tasks', viaReference.taskId)!;
    expect(linked.reworkOfTaskId).toBe(old.id);
    expect(linked.inputArtifactIds).toContain(original.id);
    expect(f.core.chief.contexts.current(reference.id).part.sourceMessageIds).toContain(
      old.sourceMessageId,
    );
    f.core.chief.contexts.rotate(first.workId, '继续修改报告', [], [original.id]);
    const continued = f.service.start(
      { workId: first.workId, goal: '修改报告 A' },
      { ...f.context, callId: 'revise' },
    );
    expect(s.get<Task>('tasks', continued.taskId)?.inputArtifactIds).toContain(original.id);
    const revision = await publish(continued.taskId, '第二版', original.id);
    expect(revision.previousArtifactId).toBe(original.id);
    expect(revision.seriesId).toBe(s.get<typeof original>('artifacts', original.id)?.seriesId);
    expect(await readFile(original.path, 'utf8')).toBe('第一版');
    expect(await readFile(revision.path, 'utf8')).toBe('第二版');
    const second = f.service.start({ goal: '制作报告 B' }, { ...f.context, callId: 'other-work' });
    const separate = await publish(second.taskId, '其他工作');
    expect(artifactVersionKey(separate, new Map())).not.toBe(
      artifactVersionKey(revision, new Map()),
    );
    await expect(publish(second.taskId, '错误引用', original.id)).rejects.toThrow('授权范围');
  });

  it('主对话补充与停止 A 时保持 B 和主轮次继续', async () => {
    const f = await fixture();
    const a = f.service.start({ goal: '制作报告 A' }, f.context);
    const b = f.service.start({ goal: '制作报告 B' }, { ...f.context, callId: 'start-b' });
    const input = await f.core.tools.execute(
      'send_task_input',
      { taskId: a.taskId, content: '增加结论' },
      'supplement-a',
      f.context,
      f.chief,
    );
    expect(input).toMatchObject({ taskId: a.taskId, status: 'pending' });
    const deliveries = f.core.state.storage.byField<{ taskId: string }>(
      'deliveries',
      'taskId',
      a.taskId,
    );
    expect(deliveries).toHaveLength(1);
    expect(f.core.state.storage.byField('deliveries', 'taskId', b.taskId)).toEqual([]);
    const stopped = await f.core.tools.execute(
      'stop_task',
      { taskId: a.taskId },
      'stop-a',
      f.context,
      f.chief,
    );
    expect(stopped).toMatchObject({ taskId: a.taskId, stopped: true, status: 'cancelled' });
    expect(f.core.state.storage.get<Task>('tasks', b.taskId)?.status).toBe('queued');
    expect(f.core.state.storage.get<Task>('tasks', f.task.id)?.status).toBe('running');
  });

  it('未指定项目使用默认目录，缺失、重名与撤销项目不会创建工作', async () => {
    const f = await fixture();
    const s = f.core.state.storage;
    const base = f.core.state.settings().defaultWorkspaceId!;
    const first = f.service.start({ goal: '制作报告' }, f.context);
    expect(s.get<Conversation>('conversations', first.conversationId)?.workspaceId).toBe(base);
    const count = s.all<Task>('tasks').length;
    expect(() =>
      f.service.start({ goal: '创建', project: '不存在' }, { ...f.context, callId: 'missing' }),
    ).toThrow('询问用户');
    for (const workspaceId of ['duplicate-a', 'duplicate-b'])
      s.put('workspaces', {
        id: workspaceId,
        name: '同名',
        path: `/tmp/${workspaceId}`,
        writable: true,
      });
    expect(() =>
      f.service.start({ goal: '创建', project: '同名' }, { ...f.context, callId: 'duplicate' }),
    ).toThrow('同名');
    s.put('workspaces', {
      id: 'revoked',
      name: '撤销',
      path: '/tmp/revoked',
      writable: true,
      enabled: false,
    });
    expect(() =>
      f.service.start(
        { goal: '创建', workspaceId: 'revoked' },
        { ...f.context, callId: 'revoked' },
      ),
    ).toThrow('撤销');
    expect(s.all<Task>('tasks')).toHaveLength(count);
  });

  it('主对话可以控制其工作的成员后代，不同后台工作保持资料和控制边界', async () => {
    const f = await fixture();
    const a = f.service.start({ goal: '制作报告 A' }, f.context);
    const b = f.service.start({ goal: '制作报告 B' }, { ...f.context, callId: 'start-b' });
    const s = f.core.state.storage;
    const taskA = s.get<Task>('tasks', a.taskId)!;
    const taskB = s.get<Task>('tasks', b.taskId)!;
    const member = f.core.entities.saveBot({
      name: '成员',
      role: '制作',
      instructions: '',
      connectionId: f.chief.connectionId,
      model: 'test',
    });
    const group = f.core.team.createTaskGroup(taskA, {
      name: '报告群',
      goal: '编写',
      memberIds: [member.id],
    });
    const child = f.core.tasks.create({
      conversationId: group.conversation.id,
      botId: member.id,
      parentId: group.task.id,
      goal: '编写',
    });
    expect(scopedTask(f.core.state, f.main.room, f.chief.id, a.taskId)?.id).toBe(a.taskId);
    expect(scopedTask(f.core.state, f.main.room, f.chief.id, child.id)?.id).toBe(child.id);
    const roomA = s.get<Conversation>('conversations', a.conversationId)!;
    expect(scopedTask(f.core.state, roomA, f.chief.id, taskB.id)).toBeUndefined();
  });

  it('主对话读取工作根任务即可取得成员的部分成果，并保持其他工作的读取边界', async () => {
    const f = await fixture();
    const work = f.service.start({ goal: '制作报告 A' }, f.context);
    const foreign = f.service.start({ goal: '制作报告 B' }, { ...f.context, callId: 'foreign' });
    const s = f.core.state.storage;
    const root = s.get<Task>('tasks', work.taskId)!;
    const member = f.core.entities.saveBot({
      name: '成员',
      role: '制作',
      instructions: '',
      connectionId: f.chief.connectionId,
      model: 'test',
    });
    const group = f.core.team.createTaskGroup(root, {
      name: '报告群',
      goal: '编写',
      memberIds: [member.id],
    });
    const child = f.core.tasks.create({
      conversationId: group.conversation.id,
      botId: member.id,
      parentId: group.task.id,
      goal: '编写',
    });
    const file = join(f.context.workspace.path, 'partial.md');
    const content = '已完成的部分成果';
    await writeFile(file, content);
    const artifact = registerTaskArtifact(
      f.core.state,
      {
        path: file,
        name: 'partial.md',
        mimeType: 'text/markdown',
        sha256: createHash('sha256').update(content).digest('hex'),
        size: Buffer.byteLength(content),
        conversationId: group.conversation.id,
        purpose: 'deliverable',
      },
      child,
      member,
      group.conversation,
      s.get<Run>('runs', f.task.runIds[0])!,
    );
    const hidden = {
      ...artifact,
      id: 'foreign-artifact',
      taskId: foreign.taskId,
      conversationId: foreign.conversationId,
    };
    s.put('artifacts', hidden);
    f.core.tasks.update(group.task, { status: 'waiting_children', artifactIds: [hidden.id] });
    expect(f.context.findArtifact(artifact.id)).toBeUndefined();
    const inspected = (await f.core.tools.execute(
      'get_task',
      { taskId: root.id },
      'partial-result',
      f.context,
      f.chief,
    )) as { artifactIds: string[] };
    expect(inspected.artifactIds).toContain(artifact.id);
    expect(f.context.findArtifact(artifact.id)?.id).toBe(artifact.id);
    expect(f.context.findArtifact(hidden.id)).toBeUndefined();
    expect(Buffer.from(await f.context.readArtifact!(artifact.id)).toString()).toBe(content);
  });

  it('历史任务重试使用同一工作的新执行段和新任务，原记录保持终态', async () => {
    const f = await fixture();
    const started = f.service.start({ goal: '制作报告 A' }, f.context);
    const s = f.core.state.storage;
    const old = s.get<Task>('tasks', started.taskId)!;
    f.core.tasks.update(old, { status: 'failed', error: '连接中断' });
    const work = f.core.chief.contexts.current(started.workId).context;
    s.put('chief_contexts', { ...work, kind: 'history' });
    const replacement = f.core.tasks.retry(old.id);
    expect(replacement.id).not.toBe(old.id);
    expect(replacement.reworkOfTaskId).toBe(old.id);
    expect(replacement.conversationId).not.toBe(old.conversationId);
    expect(replacement.resumeFromRunId).toBeUndefined();
    expect(s.get<Task>('tasks', old.id)?.status).toBe('failed');
    expect(f.core.chief.contexts.current(started.workId).context.kind).toBe('work');
    expect(s.getMessage(replacement.sourceMessageId!)?.content).toContain('连接中断');
    expect(f.core.tasks.retry(old.id).id).toBe(replacement.id);
  });

  it('主对话旧工作段重试进入当前主段，仍使用连续主上下文', async () => {
    const f = await fixture();
    f.core.tasks.update(f.task, { status: 'failed', error: '连接中断' });
    const next = f.core.chief.contexts.rotate(f.main.context.id, '延续交流', [f.message.id], []);
    const replacement = f.core.tasks.retry(f.task.id);
    expect(replacement.conversationId).toBe(next.conversationId);
    expect(replacement.reworkOfTaskId).toBe(f.task.id);
    expect(f.core.chief.contexts.current(f.main.context.id).context.kind).toBe('main');
    expect(f.core.state.storage.get<Task>('tasks', f.task.id)?.status).toBe('failed');
  });

  it('恢复记录等待明确重试，后台状态变化不会自行唤醒主对话', async () => {
    const f = await fixture();
    const started = f.service.start({ goal: '制作报告 A' }, f.context);
    const s = f.core.state.storage;
    s.setMetadata('chief-restored-report-tasks', [started.taskId]);
    const work = s.get<Task>('tasks', started.taskId)!;
    f.core.tasks.update(work, { status: 'interrupted', error: '恢复后等待重试' });
    f.core.tasks.update(f.task, { status: 'completed' });
    f.service.startReports();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.byField<Task>('tasks', 'conversationId', f.main.room.id)).toHaveLength(1);
    expect(
      s.metadata<unknown[]>(`chief-work-reports:${f.main.context.homeConversationId}`),
    ).toEqual([]);
    const retried = f.core.tasks.retry(work.id);
    expect(s.metadata('chief-restored-report-tasks')).toEqual([]);
    f.core.tasks.update(retried, { status: 'completed', result: '明确重试后交付' });
    await eventually(() => s.byField<Task>('tasks', 'conversationId', f.main.room.id).length === 2);
  });

  it('真实安排进展按事件记录，主对话忙碌期间的进展合并为最新交付回报', async () => {
    const f = await fixture();
    const started = f.service.start({ goal: '制作报告 A' }, f.context);
    const s = f.core.state.storage;
    const work = s.get<Task>('tasks', started.taskId)!;
    const plans = new TaskPlanService(f.core.state);
    plans.set(work, {
      title: '完成报告',
      steps: [
        {
          id: 'draft',
          title: '编写正文',
          kind: 'work',
          memberIds: [f.chief.id],
          dependencyIds: [],
        },
        {
          id: 'review',
          title: '检查交付',
          kind: 'work',
          memberIds: [f.chief.id],
          dependencyIds: ['draft'],
        },
      ],
    });
    const queue = () =>
      s.metadata<
        { taskId: string; content: string; deliveredAt?: string; supersededBy?: string }[]
      >(`chief-work-reports:${f.main.context.homeConversationId}`) ?? [];
    f.service.startReports();
    plans.update(work, { stepId: 'draft', status: 'completed' });
    await eventually(() => queue().length === 1);
    expect(queue()[0].content).toContain('已完成步骤：编写正文');
    plans.update(work, { stepId: 'review', status: 'completed' });
    await eventually(() => queue().length === 2);
    f.core.tasks.update(work, { status: 'completed', result: '报告已交付' });
    await eventually(() => queue().length === 3);
    f.core.tasks.update(f.task, { status: 'completed' });
    await eventually(() => s.byField<Task>('tasks', 'conversationId', f.main.room.id).length === 2);
    const report = s.byField<Task>('tasks', 'conversationId', f.main.room.id).at(-1)!;
    expect(report.goal).toContain('报告已交付');
    expect(report.goal.match(/后台工作回报：/g)).toHaveLength(1);
    expect(queue().every((entry) => entry.deliveredAt)).toBe(true);
    expect(queue().filter((entry) => entry.supersededBy)).toHaveLength(2);
  });

  it('后台回报等待主轮次结束，只写一次隐含输入并唤醒主对话', async () => {
    const f = await fixture();
    const work = f.service.start({ goal: '制作报告 A' }, f.context);
    const s = f.core.state.storage;
    const task = s.get<Task>('tasks', work.taskId)!;
    f.service.startReports();
    f.core.tasks.update(task, { status: 'completed', result: '报告 A 已交付' });
    await eventually(
      () =>
        (s.metadata<unknown[]>(`chief-work-reports:${f.main.context.homeConversationId}`) ?? [])
          .length === 1,
    );
    expect(s.byField<Task>('tasks', 'conversationId', f.main.room.id)).toHaveLength(1);
    f.core.tasks.update(f.task, { status: 'completed' });
    await eventually(() => s.byField<Task>('tasks', 'conversationId', f.main.room.id).length === 2);
    const report = s.byField<Task>('tasks', 'conversationId', f.main.room.id).at(-1)!;
    expect(report.goal).toContain('报告 A 已交付');
    expect(s.getMessage(report.sourceMessageId!)?.authorType).toBe('system');
    f.core.state.changed();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(s.byField<Task>('tasks', 'conversationId', f.main.room.id)).toHaveLength(2);
    expect(
      f.core.chief.timeline.page().messages.some((message) => message.authorType === 'system'),
    ).toBe(false);
  });
});
