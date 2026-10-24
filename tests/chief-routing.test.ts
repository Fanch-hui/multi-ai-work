import { describe, expect, it } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import type {
  Artifact,
  Connection,
  Conversation,
  Message,
  Snapshot,
  Task,
} from '../src/domain/types.js';
import type { ChiefInput, ChiefTimelinePage } from '../src/domain/chief-work.js';
import type { CoreService } from '../src/core/service.js';
import { CoreService as Core } from '../src/core/service.js';
import { caps, eventually, resources, setup } from './core-harness.js';

interface Sent {
  inputId: string;
  messageId: string;
  taskIds: string[];
}
interface Work {
  workId: string;
  taskId: string;
  conversationId: string;
}
async function fixture(run: (context: RunContext) => Promise<{ text: string }>) {
  const f = await setup(run);
  f.core.state.storage.put('connections', {
    ...f.core.state.storage.get<Connection>('connections', f.connection.id)!,
    concurrency: 5,
  });
  await f.core.request('chief.configure', {
    input: {
      connectionId: f.connection.id,
      model: 'test',
      memoryMode: 'off',
      approvalMode: 'auto',
      toolNames: ['start_work', 'list_work', 'read_artifact', 'recall_work', 'read_work_history'],
    },
  });
  return { ...f, homeId: f.core.state.settings().mainConversationId! };
}
const input = (core: CoreService, id: string) =>
  core.state.storage.get<ChiefInput>('chief_inputs', id)!;
const task = (core: CoreService, id: string) => core.state.storage.get<Task>('tasks', id)!;
async function completed(core: CoreService, id: string) {
  await eventually(
    () => ['completed', 'failed', 'cancelled'].includes(task(core, id)?.status ?? ''),
    5000,
  );
  expect(task(core, id)).toMatchObject({ status: 'completed' });
}
const send = async (core: CoreService, fields: Record<string, unknown>) =>
  (await core.request('chief.inputs.send', fields)) as Sent;
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitGate(promise: Promise<void>, signal: AbortSignal) {
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  ]);
}

describe('连续管家主对话', () => {
  it('主任务执行时回复旧段原文，补充仍携带确切引用与要求', async () => {
    const held = gate();
    let started = false;
    let received = '';
    const f = await fixture(async (context) => {
      context.emit({ type: 'text', data: { delta: '正在核对' } });
      started = true;
      await waitGate(held.promise, context.signal);
      const messages = context.userInput!.take();
      received = messages.map((message) => message.content).join('\n');
      context.userInput!.acknowledge?.(
        messages.flatMap((message) => (message.sourceMessageId ? [message.sourceMessageId] : [])),
      );
      return { text: '按旧段要求接续' };
    });
    const legacy = f.core.chief.contexts.create({ kind: 'history', title: '报告原要求' });
    const original = f.core.state.storage.appendMessage({
      id: 'old-requirement',
      conversationId: legacy.conversationId,
      authorType: 'user',
      content: '报告保持 9% 税率',
      artifactIds: [],
      status: 'committed',
      createdAt: '2026-10-23T10:00:00Z',
    });
    try {
      const first = await send(f.core, { content: '正在讨论报告' });
      await eventually(() => started);
      const supplement = await send(f.core, {
        content: '按这个要求继续',
        replyToMessageId: original.id,
      });
      expect(supplement.taskIds).toEqual(first.taskIds);
      held.release();
      await completed(f.core, first.taskIds[0]);
      expect(received).toContain(original.id);
      expect(received).toContain('报告保持 9% 税率');
    } finally {
      held.release();
    }
  });
  it('问候、能力询问和追问共用真实绑定与前文，只创建主聊天轮次', async () => {
    const seen: RunContext[] = [];
    const f = await fixture(async (context) => {
      seen.push(context);
      return { text: `第${seen.length}次答复：保持前文` };
    });
    const sent: Sent[] = [];
    for (const content of ['你好', '你能做什么', '那刚才说的呢']) {
      const value = await send(f.core, { content });
      sent.push(value);
      await completed(f.core, value.taskIds[0]);
    }
    const main = f.core.chief.contexts.main();
    expect(new Set(seen.map((context) => context.binding.id)).size).toBe(1);
    expect(seen.map((context) => context.binding.conversationId)).toEqual([
      main.room.id,
      main.room.id,
      main.room.id,
    ]);
    expect(JSON.stringify(seen[2].messages)).toContain('你好');
    expect(JSON.stringify(seen[2].messages)).toContain('第1次答复');
    expect(f.core.chief.contexts.list().filter((context) => context.kind === 'work')).toEqual([]);
    expect(f.core.state.storage.all<Task>('tasks').filter((value) => value.kind)).toEqual([]);
    for (const value of sent) {
      expect(input(f.core, value.inputId)).toMatchObject({
        status: 'dispatched',
        contextId: main.context.id,
      });
      expect(f.core.state.storage.getMessage(value.messageId)?.conversationId).toBe(main.room.id);
    }
  });

  it('A 在后台执行时主对话可讨论 B，实际回报保留工作归属且正文只存一次', async () => {
    const held = gate();
    let work: Work | undefined;
    let workerStarted = false;
    const f = await fixture(async (context) => {
      const room = f.core.state.storage.get<Conversation>(
        'conversations',
        context.binding.conversationId,
      )!;
      if (room.chiefRole === 'work') {
        workerStarted = true;
        await waitGate(held.promise, context.signal);
        return { text: '报告 A 已交付' };
      }
      if (!work) {
        work = (await context.executeTool(
          'start_work',
          { goal: '制作报告 A' },
          'start-report',
        )) as Work;
        return { text: '报告 A 已安排' };
      }
      return {
        text: context.prompt.includes('后台工作回报') ? '报告 A 的结果已收到' : '继续讨论 B',
      };
    });
    try {
      const a = await send(f.core, { content: '开始报告 A' });
      await completed(f.core, a.taskIds[0]);
      await eventually(() => workerStarted);
      const b = await send(f.core, { content: '我们先讨论 B' });
      await completed(f.core, b.taskIds[0]);
      expect(task(f.core, work!.taskId).status).toBe('running');
      expect(task(f.core, work!.taskId).parentId).toBeUndefined();
      const mainId = f.core.chief.contexts.main().context.id;
      held.release();
      await completed(f.core, work!.taskId);
      await eventually(() =>
        f.core.chief.timeline
          .page()
          .messages.some((message) => message.content === '报告 A 的结果已收到'),
      );
      expect(f.core.chief.contexts.main().context.id).toBe(mainId);
      const timeline = f.core.chief.timeline.page();
      expect(timeline.messages.some((message) => message.content === '报告 A 已交付')).toBe(false);
      expect(
        f.core.state.storage
          .messages(work!.conversationId)
          .filter((message) => message.content === '报告 A 已交付'),
      ).toHaveLength(1);
      for (const value of [a, b]) {
        expect(timeline.messages.filter((message) => message.id === value.messageId)).toHaveLength(
          1,
        );
        expect(
          f.core.state.storage.messages().filter((message) => message.id === value.messageId),
        ).toHaveLength(1);
      }
    } finally {
      held.release();
    }
  });

  it('主入口附件只显式授予选中的后台工作，其他工作与成员群继续隔离', async () => {
    let artifactId = '';
    const works: Work[] = [];
    const reads = new Map<string, unknown>();
    const f = await fixture(async (context) => {
      const room = f.core.state.storage.get<Conversation>(
        'conversations',
        context.binding.conversationId,
      )!;
      if (room.chiefRole === 'main') {
        if (!works.length) {
          works.push(
            (await context.executeTool(
              'start_work',
              { goal: '核查专属资料', artifactIds: [artifactId] },
              'read-own',
            )) as Work,
          );
          works.push(
            (await context.executeTool(
              'start_work',
              { goal: '检查其他工作权限' },
              'read-other',
            )) as Work,
          );
        }
        return { text: '已安排核查' };
      }
      reads.set(room.id, await context.executeTool('read_artifact', { artifactId }, 'read-file'));
      return { text: '权限检查完成' };
    });
    const upload = (await f.core.request('conversations.attachBytes', {
      conversationId: f.homeId,
      name: '资料.txt',
      mimeType: 'text/plain',
      data: Buffer.from('本次核查的专属资料').toString('base64'),
    })) as { artifact: Artifact };
    artifactId = upload.artifact.id;
    const own = await send(f.core, { content: '核查资料', artifactIds: [artifactId] });
    await completed(f.core, own.taskIds[0]);
    await eventually(
      () =>
        works.length === 2 &&
        works.every((work) => task(f.core, work.taskId).status === 'completed'),
    );
    expect(JSON.stringify(reads.get(works[0].conversationId))).toContain('本次核查的专属资料');
    expect(JSON.stringify(reads.get(works[1].conversationId))).toContain('未授权');
    const member = f.bot('成员', ['read_artifact']);
    const group = f.core.entities.createConversation({
      name: '成员群',
      kind: 'group',
      memberIds: [member.id],
      chiefId: member.id,
      workspaceId: f.core.state.settings().defaultWorkspaceId!,
    });
    const sent = (await f.core.request('conversations.send', {
      conversationId: group.id,
      content: '检查资料',
    })) as { taskIds: string[] };
    await completed(f.core, sent.taskIds[0]);
    expect(JSON.stringify(reads.get(group.id))).toContain('未授权');
    expect(f.core.state.storage.get<Artifact>('artifacts', artifactId)?.conversationId).toBe(
      f.homeId,
    );
    expect(f.core.state.storage.getMessage(own.messageId)?.artifactIds).toEqual([artifactId]);
  });

  it('发送幂等，模型失败后重试沿用原消息与时间线位置', async () => {
    let calls = 0;
    const f = await fixture(async () => {
      if (++calls === 1) throw new Error('HTTP 400: 本次请求失败');
      return { text: '重试后完成' };
    });
    const fields = { content: '整理本次报告', requestId: 'persistent-input' };
    const first = await send(f.core, fields);
    expect(await send(f.core, fields)).toEqual(first);
    await eventually(() => task(f.core, first.taskIds[0]).status === 'failed');
    expect(f.core.state.snapshot().chief?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.inputId, status: 'dispatched' }),
      ]),
    );
    const sequence = f.core.chief.timeline
      .page()
      .messages.find((message) => message.id === first.messageId)?.chiefTimelineSequence;
    await f.core.request('chief.inputs.retry', { id: first.inputId });
    const current = input(f.core, first.inputId);
    await completed(f.core, current.taskIds[0]);
    expect(calls).toBe(2);
    expect(await send(f.core, fields)).toEqual({ ...first, taskIds: current.taskIds });
    const matches = f.core.chief.timeline
      .page()
      .messages.filter((message) => message.id === first.messageId);
    expect(matches).toHaveLength(1);
    expect(matches[0].chiefTimelineSequence).toBe(sequence);
    expect(
      f.core.state.storage.messages().filter((message) => message.id === first.messageId),
    ).toHaveLength(1);
    await expect(send(f.core, { ...fields, content: '不同内容' })).rejects.toThrow('不匹配');
  });

  it('整理期间保存的输入重启后接入主段，原消息 ID 与显示序号稳定', async () => {
    const f = await fixture(async () => ({ text: '完成' }));
    const main = f.core.chief.contexts.main();
    f.core.chief.close();
    f.core.state.storage.setMetadata(`chief-maintenance:${main.context.id}`, { status: 'judging' });
    const pending = await send(f.core, { content: '整理时补充的要求', requestId: 'restart-input' });
    expect(input(f.core, pending.inputId).status).toBe('pending');
    const before = f.core.chief.timeline
      .page()
      .messages.find((message) => message.id === pending.messageId)!;
    await f.core.close();
    const reopened = new Core(f.root, undefined, undefined, [
      {
        kind: 'custom',
        probe: async () => ({ models: [], capabilities: caps }),
        run: async () => ({ text: '重启后已接收' }),
      },
    ]);
    const resource = resources.find((value) => value.core === f.core)!;
    resource.core = reopened;
    await reopened.start();
    await eventually(() => input(reopened, pending.inputId).status === 'dispatched');
    await completed(reopened, input(reopened, pending.inputId).taskIds[0]);
    const after = reopened.chief.timeline
      .page()
      .messages.find((message) => message.id === pending.messageId)!;
    expect(after.chiefTimelineSequence).toBe(before.chiefTimelineSequence);
    expect(after.conversationId).toBe(main.room.id);
    expect(
      reopened.state.storage.messages().filter((message) => message.id === pending.messageId),
    ).toHaveLength(1);
    expect(
      await send(reopened, { content: '整理时补充的要求', requestId: 'restart-input' }),
    ).toMatchObject({ inputId: pending.inputId, messageId: pending.messageId });
  });

  it('主时间线跨工作段分页，已读确认精确写回各自来源', async () => {
    let answers = 0;
    const f = await fixture(async () => ({ text: `连续回复${++answers}` }));
    const replies: Message[] = [];
    for (let index = 0; index < 3; index++) {
      const main = f.core.chief.contexts.main();
      const sent = await send(f.core, { content: `连续用户消息${index}` });
      await completed(f.core, sent.taskIds[0]);
      replies.push(
        f.core.state.storage
          .messages(main.room.id)
          .find((message) => message.authorType === 'bot' && message.status === 'committed')!,
      );
      if (index < 2)
        f.core.chief.contexts.rotate(
          main.context.id,
          '延续同一主对话',
          [sent.messageId, replies[index].id],
          [],
        );
    }
    const collected: Message[] = [];
    let before: number | undefined;
    do {
      const page = (await f.core.request('conversations.messages', {
        id: f.homeId,
        before,
        limit: 2,
      })) as ChiefTimelinePage;
      collected.unshift(...page.messages);
      before = page.nextBefore;
    } while (before !== undefined);
    expect(new Set(collected.map((message) => message.id)).size).toBe(collected.length);
    expect(collected.filter((message) => message.authorType === 'user')).toHaveLength(3);
    expect(collected.map((message) => message.chiefTimelineSequence)).toEqual(
      collected.map((message) => message.chiefTimelineSequence).sort((a, b) => a! - b!),
    );
    expect(
      ((await f.core.request('state.snapshot')) as Snapshot).conversations.find(
        (room) => room.id === f.homeId,
      )?.unreadCount,
    ).toBe(3);
    await f.core.request('chief.timeline.read', { messageIds: [replies[0].id] });
    expect(
      f.core.state.storage.metadata<{ sequence: number }>(
        `conversation-read:${replies[0].conversationId}`,
      )?.sequence,
    ).toBe(replies[0].sequence);
    expect(
      f.core.state.storage.metadata<{ sequence: number }>(
        `conversation-read:${replies[1].conversationId}`,
      )?.sequence ?? 0,
    ).toBe(0);
    await f.core.request('conversations.read', { id: f.homeId, messageIds: [replies[1].id] });
    expect(
      ((await f.core.request('state.snapshot')) as Snapshot).conversations.find(
        (room) => room.id === f.homeId,
      )?.unreadCount,
    ).toBe(1);
    for (const reply of replies)
      expect(f.core.state.storage.getMessage(reply.id)?.sequence).toBe(reply.sequence);
  });

  it('回复旧历史仍在主对话交流，相关原文可展开且原消息保持原位', async () => {
    let sourceId = '';
    const f = await fixture(async (context) => {
      expect(context.binding.conversationId).toBe(f.core.chief.contexts.main().room.id);
      const history = await context.executeTool(
        'read_work_history',
        { messageId: sourceId },
        'expand-history',
      );
      expect(JSON.stringify(history)).toContain('预算报告保留税率 9%');
      expect(context.prompt).toContain('预算报告保留税率 9%');
      return { text: '已根据原要求继续讨论预算报告' };
    });
    const legacy = f.core.chief.contexts.create({ kind: 'history', title: '昨天的预算报告' });
    const original = f.core.state.storage.appendMessage({
      id: 'legacy-source',
      conversationId: legacy.conversationId,
      authorType: 'user',
      content: '预算报告保留税率 9%',
      artifactIds: [],
      status: 'committed',
      createdAt: '2026-10-23T10:00:00.000Z',
    });
    sourceId = original.id;
    const sent = await send(f.core, {
      content: '继续昨天的预算报告',
      targetContextId: legacy.id,
      replyToMessageId: sourceId,
    });
    await completed(f.core, sent.taskIds[0]);
    expect(input(f.core, sent.inputId).contextId).toBe(f.core.chief.contexts.main().context.id);
    expect(f.core.state.storage.getMessage(original.id)).toEqual(original);
    expect(f.core.chief.contexts.list().filter((context) => context.kind === 'work')).toHaveLength(
      0,
    );
    expect(
      f.core.chief.timeline.page().messages.some((message) => message.id === original.id),
    ).toBe(false);
  });
});
