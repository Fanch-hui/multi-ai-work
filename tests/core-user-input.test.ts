import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { Artifact, Connection, SessionBinding, Task, TaskInput } from '../src/domain/types.js';
import type { ModelHistoryEntry } from '../src/runtime/model-history.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';
import { TaskInputService } from '../src/core/task-inputs.js';
import { State } from '../src/core/state.js';
import { importAttachmentBytes } from '../src/core/attachments.js';
import { eventually, setup } from './core-harness.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

async function modelServer(first: ReturnType<typeof gate>) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const index = requests.length;
    if (index === 1) await first.promise;
    let content = '新任务答复';
    if (index === 1) content = '原需求的答复';
    else if (index === 2) content = '已按补充调整';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({
        id: `reply-${index}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test',
        choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe('执行中的用户补充', () => {
  it('真实托管协议在同一任务与 run 处理补充，回复排序正确且下一轮不重复送达', async () => {
    const first = gate(),
      model = await modelServer(first),
      adapter = new CustomApiAdapter();
    const { core, connection } = await setup((context) => adapter.run(context));
    core.state.storage.put('connections', {
      ...core.state.storage.get<Connection>('connections', connection.id)!,
      baseUrl: model.baseUrl,
      protocol: 'chat-completions',
      authMode: 'none',
    });
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', memoryMode: 'off' },
    });
    const room = core.state.settings().mainConversationId!;
    const original = core.tasks.send({ conversationId: room, content: '原需求' });
    let supplement!: ReturnType<typeof core.tasks.send>;
    try {
      await eventually(() => model.requests.length === 1);
      supplement = core.tasks.send({
        conversationId: room,
        content: '补充要求',
        requestId: 'supplement',
      });
      expect(supplement.taskIds).toEqual(original.taskIds);
      expect(
        core.tasks.send({ conversationId: room, content: '补充要求', requestId: 'supplement' }),
      ).toEqual(supplement);
      expect(core.state.snapshot().tasks).toHaveLength(1);
      expect(core.state.snapshot().taskInputs).toHaveLength(1);
    } finally {
      first.release();
    }
    await eventually(
      () => core.state.storage.get<Task>('tasks', original.taskIds[0])?.status === 'completed',
    );
    expect(core.state.snapshot().runs).toHaveLength(1);
    expect(core.state.storage.messages(room).map((message) => message.content)).toEqual([
      '原需求',
      '补充要求',
      '已按补充调整',
    ]);
    const inputs = model.requests[1].messages.filter(
      (message) => message.role !== 'system' && !message.content.startsWith('App 当前运行资料（'),
    );
    expect(inputs.map((message) => message.role)).toEqual(['user', 'user']);
    expect(inputs[1].content).toBe('补充要求');
    const binding = core.state.storage.all<SessionBinding>('session_bindings')[0];
    const history = core.state.storage.metadata<ModelHistoryEntry[]>(`history:${binding.id}`)!;
    expect(history.find((entry) => entry.message.content === '补充要求')).toMatchObject({
      messageId: supplement.messageId,
      sequence: core.state.storage.getMessage(supplement.messageId)!.sequence,
    });
    expect(core.state.snapshot().taskInputs[0].status).toBe('delivered');
    const next = core.tasks.send({ conversationId: room, content: '新工作' });
    expect(next.taskIds).not.toEqual(original.taskIds);
    await eventually(
      () => core.state.storage.get<Task>('tasks', next.taskIds[0])?.status === 'completed',
    );
    expect(
      model.requests[2].messages.filter((message) => message.content === '补充要求'),
    ).toHaveLength(1);
    expect(model.requests[2].messages.at(-1)?.content).not.toContain('用户：补充要求');
  });

  it('群聊对忙成员插入原任务，空闲成员立即正常回复，显式 @ 不触发其他成员', async () => {
    const work = gate();
    let busyId = '',
      idleReplies = 0;
    const { core, connection, bot } = await setup(async (context) => {
      if (context.bot.id !== busyId) {
        idleReplies++;
        return { text: '空闲成员正常回复' };
      }
      context.emit({ type: 'text', data: { delta: '正在处理原任务' } });
      await work.promise;
      const messages = context.userInput!.take();
      expect(messages.map((message) => message.content)).toEqual(['全群补充', '仅给忙成员的补充']);
      context.userInput!.beginReply('正在处理原任务');
      return { text: '忙成员按补充完成原任务' };
    });
    const busy = bot('忙成员'),
      idle = bot('空闲成员');
    busyId = busy.id;
    for (const member of [busy, idle]) core.entities.saveBot({ ...member, memoryMode: 'off' });
    core.state.storage.put('connections', {
      ...core.state.storage.get<Connection>('connections', connection.id)!,
      concurrency: 2,
    });
    const room = core.entities.createConversation({
      name: '工作群',
      kind: 'group',
      chiefId: busy.id,
      memberIds: [busy.id, idle.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const original = core.tasks.send({
      conversationId: room.id,
      content: '原任务',
      targetBotIds: [busy.id],
    });
    try {
      await eventually(
        () => core.state.storage.get<Task>('tasks', original.taskIds[0])?.status === 'running',
      );
      const all = core.tasks.send({ conversationId: room.id, content: '全群补充' });
      expect(all.taskIds[0]).toBe(original.taskIds[0]);
      await eventually(
        () =>
          idleReplies === 1 &&
          core.state.storage.get<Task>('tasks', all.taskIds[1])?.status === 'completed',
      );
      const selected = core.tasks.send({
        conversationId: room.id,
        content: '仅给忙成员的补充',
        targetBotIds: [busy.id],
      });
      expect(selected.taskIds).toEqual(original.taskIds);
      expect(core.state.snapshot().taskInputs.every((input) => input.botId === busy.id)).toBe(true);
      expect(core.state.snapshot().tasks).toHaveLength(2);
    } finally {
      work.release();
    }
    await eventually(
      () => core.state.storage.get<Task>('tasks', original.taskIds[0])?.status === 'completed',
    );
    expect(idleReplies).toBe(1);
    expect(core.state.snapshot().runs).toHaveLength(2);
    expect(core.state.snapshot().taskInputs.every((input) => input.status === 'delivered')).toBe(
      true,
    );
  });

  it('等待成员的主管接收补充后继续同一任务，后台整理不占用用户消息', async () => {
    const { core, connection, bot } = await setup(async () => ({ text: '回复' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', memoryMode: 'off' },
    });
    const room = core.state.settings().mainConversationId!,
      chief = core.state.settings().mainBotId!;
    const task = core.tasks.create({ conversationId: room, botId: chief, goal: '等待协作' });
    core.tasks.update(task, { status: 'waiting_children' });
    const sent = core.tasks.send({ conversationId: room, content: '调整后续安排' });
    expect(sent.taskIds).toEqual([task.id]);
    expect(core.state.storage.get<Task>('tasks', task.id)?.status).toBe('queued');
    const worker = bot('整理员');
    const privateRoom = core.entities.createConversation({
      name: '私聊',
      kind: 'private',
      memberIds: [worker.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const background = core.tasks.create({
      conversationId: privateRoom.id,
      botId: worker.id,
      goal: '整理记忆',
      kind: 'memory-review',
    });
    core.tasks.update(background, { status: 'running' });
    const normal = core.tasks.send({ conversationId: privateRoom.id, content: '用户新消息' });
    expect(normal.taskIds).not.toContain(background.id);
    core.tasks.update(background, { status: 'completed' });
    const queued = core.tasks.create({
      conversationId: privateRoom.id,
      botId: worker.id,
      goal: '尚未开始的任务',
    });
    const reply = core.tasks.send({ conversationId: privateRoom.id, content: '空闲时正常回复' });
    expect(reply.taskIds).not.toContain(queued.id);
    expect(reply.taskIds).not.toEqual(normal.taskIds);
  });

  it('补充资料保留可读取的附件 ID 和图片引用，并进入原任务的输入范围', async () => {
    const work = gate();
    let image!: Artifact, document!: Artifact;
    const { core, bot } = await setup(async (context) => {
      await work.promise;
      const messages = context.userInput!.take();
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain(`附件 ID：${document.id}、${image.id}`);
      expect(messages[0].images?.map((item) => item.artifactId)).toEqual([image.id]);
      const resolved = await context.resolveImage!(messages[0].images![0]);
      expect((await sharp(Buffer.from(resolved.data, 'base64')).metadata()).width).toBe(8);
      expect(
        await context.executeTool('read_artifact', { artifactId: document.id }, 'read-supplement'),
      ).toMatchObject({ content: '补充资料' });
      return { text: '已按补充资料完成' };
    });
    const member = bot('资料助手', ['read_artifact']);
    core.entities.saveBot({ ...member, memoryMode: 'off' });
    const room = core.entities.createConversation({
      name: '资料',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const original = core.tasks.send({ conversationId: room.id, content: '先开始工作' });
    try {
      await eventually(
        () => core.state.storage.get<Task>('tasks', original.taskIds[0])?.status === 'running',
      );
      document = await importAttachmentBytes(
        core.state,
        room.id,
        '补充.txt',
        'text/plain',
        Buffer.from('补充资料').toString('base64'),
      );
      const bytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#456789' },
      })
        .png()
        .toBuffer();
      image = await importAttachmentBytes(
        core.state,
        room.id,
        '图.png',
        'image/png',
        bytes.toString('base64'),
      );
      expect(
        core.tasks.send({
          conversationId: room.id,
          content: '参考这些资料',
          artifactIds: [document.id, image.id],
        }).taskIds,
      ).toEqual(original.taskIds);
    } finally {
      work.release();
    }
    await eventually(
      () => core.state.storage.get<Task>('tasks', original.taskIds[0])?.status === 'completed',
    );
    expect(core.state.storage.get<Task>('tasks', original.taskIds[0])?.inputArtifactIds).toEqual([
      document.id,
      image.id,
    ]);
    expect(core.state.snapshot().taskInputs[0].status).toBe('delivered');
  });

  it('未完成接收的补充在重启恢复后仍可读取，停止后保留原消息', async () => {
    const { core, connection } = await setup(async () => ({ text: '回复' }));
    core.scheduler.pause();
    await core.request('chief.configure', {
      input: { connectionId: connection.id, model: 'test', memoryMode: 'off' },
    });
    const room = core.state.settings().mainConversationId!;
    const original = core.tasks.send({ conversationId: room, content: '原任务' });
    core.tasks.update(core.state.storage.get<Task>('tasks', original.taskIds[0])!, {
      status: 'running',
    });
    const supplement = core.tasks.send({ conversationId: room, content: '不能丢失的补充' });
    const input = core.state.snapshot().taskInputs[0];
    core.state.storage.put('deliveries', { ...input, status: 'claimed', runId: 'crashed-run' });
    const reopened = new State(core.state.dataDirectory);
    try {
      expect(reopened.storage.getMessage(supplement.messageId)?.content).toBe('不能丢失的补充');
      core.scheduler.resume(true);
      core.scheduler.pause();
      expect(core.state.snapshot().taskInputs[0].status).toBe('pending');
      await core.scheduler.cancel(original.taskIds[0]);
      expect(core.state.storage.get<Task>('tasks', original.taskIds[0])?.status).toBe('cancelled');
      expect(core.state.storage.getMessage(supplement.messageId)?.content).toBe('不能丢失的补充');
      const service = new TaskInputService(core.state);
      expect(service.hasPending(original.taskIds[0])).toBe(true);
      expect(reopened.storage.all<TaskInput>('deliveries')[0].messageId).toBe(supplement.messageId);
    } finally {
      reopened.storage.close();
    }
  });
});
