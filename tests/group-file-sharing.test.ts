import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Artifact, Bot, Conversation, Run, Task } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { TaskInputService } from '../src/core/task-inputs.js';
import { setup } from './core-harness.js';

async function fixture() {
  const { core, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const chief = core.entities.saveBot({
    ...bot('Chief', [
      'post_message',
      'write_artifact',
      'read_artifact',
      'delegate_task',
      'send_task_input',
    ]),
    approvalMode: 'auto',
    memoryMode: 'off',
  });
  const member = core.entities.saveBot({
    ...bot('资料成员', ['post_message', 'write_artifact', 'read_artifact']),
    approvalMode: 'auto',
    memoryMode: 'off',
  });
  const room = core.state.storage.get<Conversation>(
    'conversations',
    core.state.settings().mainConversationId!,
  )!;
  const source = core.tasks.create({ conversationId: room.id, botId: chief.id, goal: '完成材料' });
  const group = core.team.createTaskGroup(source, {
    name: '材料群',
    goal: '整理材料',
    memberIds: [member.id],
  });
  const actor = (task: Task, actorBot: Bot, conversation: Conversation) => {
    const run: Run = {
      id: id(),
      taskId: task.id,
      botId: actorBot.id,
      bindingId: id(),
      status: 'running',
      configRevision: actorBot.revision,
      createdAt: now(),
      requirementVersion: 1,
    };
    core.state.storage.put('runs', run);
    const current = core.tasks.update(task, { status: 'running', runIds: [run.id] });
    const context = core.tools.context(
      run,
      current,
      actorBot,
      conversation,
      core.state.snapshot().workspaces[0],
      new AbortController().signal,
    );
    return {
      run,
      context,
      task: current,
      tool: (name: string, args: Record<string, unknown>) =>
        core.tools.execute(name, args, id(), context, actorBot),
    };
  };
  const worker = () =>
    actor(
      core.tasks.create({
        conversationId: group.conversation.id,
        botId: member.id,
        parentId: group.task.id,
        goal: '阅读材料',
      }),
      member,
      group.conversation,
    );
  return {
    core,
    chief,
    member,
    room,
    source,
    group,
    actor,
    worker,
    sourceActor: actor(source, chief, room),
  };
}

describe('主管群文件共享', () => {
  it('来源主管只共享指定文件，已有群成员上下文可读取且原始成果归属保持不变', async () => {
    const f = await fixture();
    const worker = f.worker();
    const shared = (await f.sourceActor.tool('write_artifact', {
      path: '共享材料.md',
      format: 'markdown',
      content: '群内可读材料',
    })) as Artifact;
    const privateFile = (await f.sourceActor.tool('write_artifact', {
      path: '私人材料.md',
      format: 'markdown',
      content: '主对话私密内容',
    })) as Artifact;
    expect(await worker.tool('read_artifact', { artifactId: shared.id })).toMatchObject({
      error: expect.stringContaining('未授权'),
    });
    const tasksBefore = f.core.state.storage.all<Task>('tasks');
    const posted = (await f.sourceActor.tool('post_message', {
      conversationId: f.group.conversation.id,
      artifactIds: [shared.id],
    })) as { messageId: string };
    expect(f.core.state.storage.getMessage(posted.messageId)).toMatchObject({
      conversationId: f.group.conversation.id,
      authorType: 'bot',
      authorBotId: f.chief.id,
      content: '',
      artifactIds: [shared.id],
      status: 'committed',
    });
    expect(f.core.state.storage.all<Task>('tasks')).toEqual(tasksBefore);
    expect(await worker.tool('read_artifact', { artifactId: shared.id })).toMatchObject({
      content: '群内可读材料',
    });
    expect(await worker.tool('read_artifact', { artifactId: privateFile.id })).toMatchObject({
      error: expect.stringContaining('未授权'),
    });
    expect(f.core.state.storage.get<Artifact>('artifacts', shared.id)).toEqual(shared);
    expect(shared).toMatchObject({
      taskId: f.source.id,
      botId: f.chief.id,
      conversationId: f.room.id,
    });
    expect(await readFile(shared.path, 'utf8')).toBe('群内可读材料');
  });

  it('群主管发表文件后通过委派交给成员，成员仍可在当前群发表该文件', async () => {
    const f = await fixture();
    const chief = f.actor(f.group.task, f.chief, f.group.conversation);
    const artifact = (await chief.tool('write_artifact', {
      path: '群内材料.md',
      format: 'markdown',
      content: '待成员处理',
    })) as Artifact;
    const posted = (await chief.tool('post_message', {
      content: '请处理材料',
      artifactIds: [artifact.id],
    })) as { messageId: string };
    expect(f.core.state.storage.getMessage(posted.messageId)?.artifactIds).toEqual([artifact.id]);
    const delegated = (await chief.tool('delegate_task', {
      botId: f.member.id,
      goal: '核查附件',
      expectedOutput: '结论',
      artifactIds: [artifact.id],
    })) as Task;
    expect(delegated).toMatchObject({
      parentId: f.group.task.id,
      conversationId: f.group.conversation.id,
      botId: f.member.id,
      inputArtifactIds: [artifact.id],
    });
    const worker = f.actor(delegated, f.member, f.group.conversation);
    expect(await worker.tool('read_artifact', { artifactId: artifact.id })).toMatchObject({
      content: '待成员处理',
    });
    const reply = (await worker.tool('post_message', { artifactIds: [artifact.id] })) as {
      messageId: string;
    };
    expect(f.core.state.storage.getMessage(reply.messageId)).toMatchObject({
      conversationId: f.group.conversation.id,
      authorBotId: f.member.id,
      artifactIds: [artifact.id],
    });
  });

  it('主管给运行中成员补发文件后复用原任务，并更新既有运行上下文的读取授权', async () => {
    const f = await fixture();
    const worker = f.worker();
    const artifact = (await f.sourceActor.tool('write_artifact', {
      path: '追加材料.md',
      format: 'markdown',
      content: '最新补充资料',
    })) as Artifact;
    expect(worker.context.findArtifact(artifact.id)).toBeUndefined();
    const before = f.core.state.snapshot().tasks.length;
    const sent = (await f.sourceActor.tool('send_task_input', {
      taskId: worker.task.id,
      content: '请结合追加资料继续',
      artifactIds: [artifact.id],
    })) as { messageId: string };
    expect(f.core.state.snapshot().tasks).toHaveLength(before);
    expect(f.core.state.storage.get<Task>('tasks', worker.task.id)).toMatchObject({
      status: 'running',
      runIds: [worker.run.id],
      inputArtifactIds: [artifact.id],
    });
    const draft = f.core.state.storage.appendMessage({
      id: id(),
      conversationId: f.group.conversation.id,
      authorType: 'bot',
      authorBotId: f.member.id,
      runId: worker.run.id,
      content: '',
      artifactIds: [],
      status: 'draft',
      createdAt: now(),
    });
    const inputs = new TaskInputService(f.core.state);
    const channel = inputs.forRun(worker.run, worker.context, 0, () => {});
    expect(channel.take()).toEqual([
      expect.objectContaining({
        sourceMessageId: sent.messageId,
        content: expect.stringContaining(artifact.id),
      }),
    ]);
    expect(await worker.tool('read_artifact', { artifactId: artifact.id })).toMatchObject({
      content: '最新补充资料',
    });
    channel.acknowledge!([sent.messageId]);
    inputs.release(worker.run.id);
    expect(f.core.state.snapshot().taskInputs).toEqual([
      expect.objectContaining({
        taskId: worker.task.id,
        messageId: sent.messageId,
        status: 'delivered',
      }),
    ]);
  });

  it('主管不能向无关群或其他主对话投递，普通成员不能跨会话发表文件', async () => {
    const f = await fixture();
    const other = f.core.team.createChiefConversation('其他主对话');
    const otherSource = f.core.tasks.create({
      conversationId: other.id,
      botId: f.chief.id,
      goal: '其他任务',
    });
    const unrelated = f.core.team.createTaskGroup(otherSource, {
      name: '其他群',
      goal: '独立材料',
      memberIds: [f.member.id],
    });
    const artifact = (await f.sourceActor.tool('write_artifact', {
      path: '受限材料.md',
      format: 'markdown',
      content: '当前来源材料',
    })) as Artifact;
    const worker = f.worker();
    const messagesBefore = [
      f.room.id,
      f.group.conversation.id,
      other.id,
      unrelated.conversation.id,
    ].map((conversationId) => f.core.state.storage.messages(conversationId));
    for (const conversationId of [other.id, unrelated.conversation.id])
      expect(
        await f.sourceActor.tool('post_message', {
          conversationId,
          content: '发送材料',
          artifactIds: [artifact.id],
        }),
      ).toHaveProperty('error');
    expect(
      await worker.tool('post_message', { conversationId: f.room.id, content: '跨会话发言' }),
    ).toHaveProperty('error');
    expect(
      [f.room.id, f.group.conversation.id, other.id, unrelated.conversation.id].map(
        (conversationId) => f.core.state.storage.messages(conversationId),
      ),
    ).toEqual(messagesBefore);
    const outsider = f.actor(unrelated.task, f.chief, unrelated.conversation);
    expect(await outsider.tool('read_artifact', { artifactId: artifact.id })).toMatchObject({
      error: expect.stringContaining('未授权'),
    });
  });
});
