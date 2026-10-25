import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChiefHistoryTaskList,
  ChiefHistoryTaskRead,
} from '../src/domain/chief-history-tasks.js';
import type { Artifact, Conversation, Run, Task } from '../src/domain/types.js';
import type { TaskWait } from '../src/domain/task-wait.js';
import { registerTaskArtifact } from '../src/core/artifact-registration.js';
import { id, now } from '../src/core/state.js';
import { setup } from './core-harness.js';

async function fixture() {
  const f = await setup(async () => ({ text: '完成' }));
  f.core.scheduler.pause();
  f.core.chief.close();
  const chief = f.bot('Chief');
  const main = f.core.chief.contexts.main();
  const work = f.core.chief.contexts.create({ kind: 'work', title: '报告 A' });
  const part = f.core.chief.contexts.current(work.id).part;
  const source = f.core.state.storage.appendMessage({
    id: id(),
    conversationId: main.room.id,
    authorType: 'user',
    content: '请制作报告 A，保留原始资料',
    artifactIds: [],
    status: 'committed',
    createdAt: now(),
  });
  const message = f.core.state.storage.appendMessage({
    id: id(),
    conversationId: work.conversationId,
    authorType: 'user',
    content: '制作报告 A',
    artifactIds: [],
    status: 'committed',
    createdAt: now(),
  });
  f.core.state.storage.setMetadata(`chief-work-source:${message.id}`, {
    sourceMessageIds: [source.id],
  });
  const task = f.core.tasks.create({
    conversationId: work.conversationId,
    botId: chief.id,
    goal: message.content,
    sourceMessageId: message.id,
  });
  return { ...f, chief, main, work, part, source, message, task };
}

describe('历史任务与上下文管理', () => {
  it('按稳定游标列出主上下文与工作，展开真实来源指令并按消息序号分页', async () => {
    const f = await fixture();
    const s = f.core.state.storage;
    for (const content of ['第一段回复', '第二段回复'])
      s.appendMessage({
        id: id(),
        conversationId: f.work.conversationId,
        authorType: 'bot',
        authorBotId: f.chief.id,
        content,
        artifactIds: [],
        status: 'committed',
        createdAt: now(),
      });
    const first = (await f.core.request('chief.history.tasks.list', {
      limit: 1,
    })) as ChiefHistoryTaskList;
    const items = [...first.items];
    let cursor = first.nextBefore;
    while (cursor) {
      const page = (await f.core.request('chief.history.tasks.list', {
        limit: 1,
        before: cursor,
      })) as ChiefHistoryTaskList;
      items.push(...page.items);
      cursor = page.nextBefore;
    }
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining([f.work.id, f.main.context.id]),
    );
    const main = items.find((item) => item.kind === 'main')!;
    expect(main.deletable).toBe(false);
    const detail = (await f.core.request('chief.history.tasks.read', {
      contextId: f.work.id,
      limit: 1,
    })) as ChiefHistoryTaskRead;
    expect(detail.instructions).toContainEqual(
      expect.objectContaining({
        messageId: f.source.id,
        content: f.source.content,
        contextId: f.main.context.id,
        contextTitle: '管家主对话',
        taskIds: [f.task.id],
      }),
    );
    expect(detail.messages.map((message) => message.content)).toEqual(['第二段回复']);
    const earlier = (await f.core.request('chief.history.tasks.read', {
      contextId: f.work.id,
      limit: 1,
      before: detail.nextBefore,
    })) as ChiefHistoryTaskRead;
    expect(earlier.messages.map((message) => message.content)).toEqual(['第一段回复']);
    await expect(
      f.core.request('chief.history.tasks.read', {
        contextId: f.main.context.id,
        partId: f.part.id,
      }),
    ).rejects.toThrow('上下文段不存在');
    await expect(
      f.core.request('chief.history.tasks.delete', { contextId: f.main.context.id }),
    ).rejects.toThrow('主对话');
    await expect(f.core.request('conversations.delete', { id: f.main.room.id })).rejects.toThrow(
      '主对话',
    );
  });

  it('活动任务和未确认命令阻止删除，其他管家的上下文保持隔离', async () => {
    const f = await fixture();
    await expect(
      f.core.request('chief.history.tasks.delete', { contextId: f.work.id }),
    ).rejects.toThrow('完成或停止');
    f.core.tasks.update(f.task, { status: 'completed' });
    const processId = id();
    f.core.state.storage.put('processes', { id: processId, taskId: f.task.id, status: 'unknown' });
    await expect(
      f.core.request('chief.history.tasks.delete', { contextId: f.work.id }),
    ).rejects.toThrow('待处理');
    f.core.state.storage.delete('processes', processId);
    f.core.state.storage.put('chief_contexts', { ...f.work, homeConversationId: 'another-home' });
    await expect(
      f.core.request('chief.history.tasks.read', { contextId: f.work.id }),
    ).rejects.toThrow('不属于');
    expect(f.core.state.storage.get('tasks', f.task.id)).toBeDefined();
  });

  it('删除各执行段及任务记录，保留主时间线原消息、成果正文和独立群聊', async () => {
    const f = await fixture();
    const s = f.core.state.storage;
    const run: Run = {
      id: id(),
      taskId: f.task.id,
      botId: f.chief.id,
      bindingId: id(),
      status: 'completed',
      configRevision: 1,
      createdAt: now(),
    };
    s.put('runs', run);
    f.core.tasks.update(f.task, { status: 'completed', runIds: [run.id] });
    const bytes = Buffer.from('报告 A 的完整正文');
    const path = join(f.root, 'report.txt');
    await writeFile(path, bytes);
    const artifact = registerTaskArtifact(
      f.core.state,
      {
        name: 'report.txt',
        conversationId: f.work.conversationId,
        path,
        mimeType: 'text/plain',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        purpose: 'deliverable',
      },
      f.task,
      f.chief,
      f.core.chief.contexts.current(f.work.id).room,
      run,
    );
    f.core.chief.timeline.add(f.message.id);
    f.core.chief.timeline.add(f.source.id);
    const reply = s.appendMessage({
      id: id(),
      conversationId: f.work.conversationId,
      authorType: 'bot',
      authorBotId: f.chief.id,
      content: '报告已交付',
      artifactIds: [artifact.id],
      status: 'committed',
      createdAt: now(),
    });
    f.core.chief.timeline.add(reply.id);
    f.core.chief.timeline.read([reply.id]);
    const receipt = s.metadata(`conversation-read:${f.work.conversationId}`);
    expect(f.core.chief.timeline.unreadCount()).toBe(0);
    const timeline = f.core.chief.timeline.page().messages.map((message) => ({
      id: message.id,
      sequence: message.chiefTimelineSequence,
      content: message.content,
    }));
    const group: Conversation = {
      id: id(),
      name: '报告讨论',
      kind: 'group',
      memberIds: [f.chief.id],
      chiefId: f.chief.id,
      workspaceId: f.work.workspaceId,
      sourceConversationId: f.work.conversationId,
      sourceTaskId: f.task.id,
      createdAt: now(),
    };
    s.put('conversations', group);
    const groupTask = f.core.tasks.create({
      conversationId: group.id,
      botId: f.chief.id,
      goal: '群内核对报告',
    });
    f.core.tasks.update(groupTask, { status: 'completed' });
    const ownWait: TaskWait = {
      id: id(),
      taskId: f.task.id,
      runId: run.id,
      conversationId: f.work.conversationId,
      botId: f.chief.id,
      kind: 'computer-handoff',
      summary: '此前请用户确认窗口',
      resourceId: 'window',
      status: 'resumed',
      createdAt: now(),
      resolvedAt: now(),
    };
    const groupWait: TaskWait = {
      ...ownWait,
      id: id(),
      taskId: groupTask.id,
      runId: id(),
      conversationId: group.id,
      status: 'cancelled',
    };
    s.put('task_waits', ownWait);
    s.put('task_waits', groupWait);
    const groupMessage = s.appendMessage({
      id: id(),
      conversationId: group.id,
      authorType: 'user',
      content: '保留群聊讨论',
      artifactIds: [],
      status: 'committed',
      createdAt: now(),
    });
    const pending = {
      id: 'report',
      workId: f.work.id,
      taskId: f.task.id,
      content: '尚未回报的结果',
      artifactIds: [],
      createdAt: now(),
    };
    s.setMetadata(`chief-work-reports:${f.core.state.settings().mainConversationId}`, [pending]);
    s.setMetadata('chief-work:source-call', {
      fingerprint: 'fingerprint',
      workId: f.work.id,
      taskId: f.task.id,
      conversationId: f.work.conversationId,
    });
    f.core.chief.contexts.rotate(f.work.id, '接续要求', [], []);
    const next = f.core.chief.contexts.current(f.work.id);
    const result = await f.core.request('chief.history.tasks.delete', { contextId: f.work.id });
    expect(result).toEqual({ deletedContextId: f.work.id });
    expect(s.get('chief_contexts', f.work.id)).toBeUndefined();
    expect(s.get('chief_parts', f.part.id)).toBeUndefined();
    expect(s.get('chief_parts', next.part.id)).toBeUndefined();
    expect(s.get('tasks', f.task.id)).toBeUndefined();
    expect(s.get('runs', run.id)).toBeUndefined();
    expect(s.get('task_waits', ownWait.id)).toBeUndefined();
    expect(s.get('task_waits', groupWait.id)).toEqual(groupWait);
    expect(s.get('conversations', next.room.id)).toBeUndefined();
    expect(
      f.core.chief.timeline.page().messages.map((message) => ({
        id: message.id,
        sequence: message.chiefTimelineSequence,
        content: message.content,
      })),
    ).toEqual(timeline);
    expect(s.metadata(`conversation-read:${f.work.conversationId}`)).toEqual(receipt);
    expect(f.core.chief.timeline.unreadCount()).toBe(0);
    expect(s.get<Conversation>('conversations', f.work.conversationId)?.timelineOnly).toBe(true);
    await expect(f.core.conversations.delete(f.work.conversationId)).rejects.toThrow('主对话消息');
    await expect(f.core.conversations.archive(f.work.conversationId, false)).rejects.toThrow(
      '主对话消息',
    );
    expect(f.core.tasks.accepting(f.work.conversationId)).toBe(false);
    expect(s.get<Conversation>('conversations', group.id)?.sourceConversationId).toBeUndefined();
    expect(s.get<Conversation>('conversations', group.id)?.sourceTaskId).toBeUndefined();
    expect(s.getMessage(groupMessage.id)?.content).toBe(groupMessage.content);
    expect(s.get<Artifact>('artifacts', artifact.id)?.sha256).toBe(artifact.sha256);
    expect(await readFile(artifact.path, 'utf8')).toBe(bytes.toString());
    expect(s.metadata(`chief-work-reports:${f.core.state.settings().mainConversationId}`)).toEqual(
      [],
    );
    expect(s.metadata('chief-work:source-call')).toMatchObject({ deleted: true });
    expect(
      f.core.chief.history
        .search({ query: f.message.content })
        .items.some((item) => item.messageId === f.message.id),
    ).toBe(false);
  });

  it('另一执行段正在修改时释放本次取得的锁，保留原占用与全部记录', async () => {
    const f = await fixture();
    f.core.tasks.update(f.task, { status: 'completed' });
    f.core.chief.contexts.rotate(f.work.id, '接续要求', [], []);
    const next = f.core.chief.contexts.current(f.work.id);
    const rooms = [f.work.conversationId, next.room.id].sort();
    f.core.tasks.blockConversation(rooms[1]);
    try {
      await expect(
        f.core.request('chief.history.tasks.delete', { contextId: f.work.id }),
      ).rejects.toThrow('正在修改');
      expect(() => f.core.tasks.blockConversation(rooms[0])).not.toThrow();
      f.core.tasks.unblockConversation(rooms[0]);
      expect(() => f.core.tasks.blockConversation(rooms[1])).toThrow('正在修改');
      expect(f.core.state.storage.get('chief_contexts', f.work.id)).toBeDefined();
      expect(f.core.state.storage.getMessage(f.message.id)?.content).toBe(f.message.content);
      expect(f.core.state.storage.get('tasks', f.task.id)).toBeDefined();
    } finally {
      f.core.tasks.unblockConversation(rooms[1]);
    }
  });

  it('保留固定主入口及旧消息，可以删除已结束的旧归属记录', async () => {
    const f = await fixture();
    const s = f.core.state.storage;
    const home = s.get<Conversation>('conversations', f.core.state.settings().mainConversationId!)!;
    const historical =
      f.core.chief.contexts
        .list()
        .find(
          (context) => context.kind === 'history' && context.conversationIds.includes(home.id),
        ) ??
      f.core.chief.contexts.create({
        kind: 'history',
        title: '此前工作',
        conversationId: home.id,
      });
    const original = s.appendMessage({
      id: id(),
      conversationId: home.id,
      authorType: 'user',
      content: '升级前的原始消息',
      artifactIds: [],
      status: 'committed',
      createdAt: now(),
    });
    f.core.chief.timeline.add(original.id);
    await f.core.request('chief.history.tasks.delete', { contextId: historical.id });
    expect(s.get<Conversation>('conversations', home.id)).toMatchObject({
      chiefRole: 'home',
      archived: false,
    });
    expect(s.getMessage(original.id)?.content).toBe(original.content);
    expect(f.core.chief.contexts.main().context.id).toBe(f.main.context.id);
  });
});
