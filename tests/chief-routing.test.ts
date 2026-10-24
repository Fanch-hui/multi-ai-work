import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { ChiefContextView, ChiefInput, ChiefTimelinePage } from '../src/domain/chief-work.js';
import type { ChiefHistorySearchResult } from '../src/domain/chief-history.js';
import type { CoreService } from '../src/core/service.js';
import { eventually, setup } from './core-harness.js';

interface Sent {
  inputId: string;
  messageId: string;
  taskIds: string[];
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
      toolNames: ['read_artifact', 'recall_work', 'read_work_history'],
    },
  });
  const homeId = f.core.state.settings().mainConversationId!;
  const project = async (name: string) => {
    const path = join(f.root, name);
    await mkdir(path);
    return f.core.entities.addWorkspace({ name, path, writable: true });
  };
  const context = async (title: string, workspaceId?: string) =>
    (await f.core.request('chief.contexts.create', { title, workspaceId })) as ChiefContextView;
  return { ...f, homeId, project, context };
}

const input = (core: CoreService, id: string) =>
  core.state.storage.get<ChiefInput>('chief_inputs', id)!;
async function dispatched(core: CoreService, sent: Sent) {
  await eventually(() => ['dispatched', 'failed'].includes(input(core, sent.inputId).status));
  expect(input(core, sent.inputId)).toMatchObject({ status: 'dispatched' });
  return input(core, sent.inputId);
}
async function completed(core: CoreService, taskId: string) {
  await eventually(
    () =>
      ['completed', 'failed', 'cancelled'].includes(
        core.state.storage.get<Task>('tasks', taskId)?.status ?? '',
      ),
    5000,
  );
  expect(core.state.storage.get<Task>('tasks', taskId)).toMatchObject({ status: 'completed' });
}
async function send(core: CoreService, fields: Record<string, unknown>) {
  return (await core.request('chief.inputs.send', fields)) as Sent;
}

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

describe('固定管家主入口路由', () => {
  it('A 在后台等待时 B 使用独立项目完成，A 回报不抢焦点且正文只有一份', async () => {
    const held = gate();
    let aId = '',
      aStarted = false;
    const seen = new Map<string, RunContext>();
    const f = await fixture(async (context) => {
      seen.set(context.binding.conversationId, context);
      if (context.binding.conversationId === aId) {
        aStarted = true;
        await waitGate(held.promise, context.signal);
        return { text: '报告 A 已交付' };
      }
      return { text: '项目 B 已完成' };
    });
    const aProject = await f.project('项目A');
    const bProject = await f.project('项目B');
    const a = await f.context('报告A', aProject.id);
    const b = await f.context('问题B', bProject.id);
    aId = a.conversationId;
    try {
      const sentA = await send(f.core, { content: '开始报告 A', targetContextId: a.id });
      await eventually(() => aStarted);
      const sentB = await send(f.core, { content: '处理项目 B', targetContextId: b.id });
      await completed(f.core, sentB.taskIds[0]);
      expect(f.core.state.storage.get<Task>('tasks', sentA.taskIds[0])?.status).toBe('running');
      expect(seen.get(a.conversationId)?.workspacePath).toBe(aProject.path);
      expect(seen.get(b.conversationId)?.workspacePath).toBe(bProject.path);
      expect(seen.get(a.conversationId)?.binding.id).not.toBe(
        seen.get(b.conversationId)?.binding.id,
      );
      expect(f.core.chief.contexts.focus().contextId).toBe(b.id);
      held.release();
      await completed(f.core, sentA.taskIds[0]);
      expect(f.core.chief.contexts.focus().contextId).toBe(b.id);
      const timeline = (await f.core.request('chief.timeline.page')) as ChiefTimelinePage;
      for (const sent of [sentA, sentB]) {
        expect(timeline.messages.filter((message) => message.id === sent.messageId)).toHaveLength(
          1,
        );
        expect(
          f.core.state.storage.messages().filter((message) => message.id === sent.messageId),
        ).toHaveLength(1);
      }
      expect(
        timeline.messages.filter((message) => message.content === '报告 A 已交付'),
      ).toHaveLength(1);
      expect(
        timeline.messages.find((message) => message.id === sentA.messageId)?.conversationId,
      ).toBe(a.conversationId);
      expect(
        f.core.state.storage
          .messages(a.conversationId)
          .some((message) => message.content === '处理项目 B'),
      ).toBe(false);
    } finally {
      held.release();
    }
  });

  it('主入口上传只授予目标事项，其他事项与普通成员群读不到资料', async () => {
    let artifactId = '',
      aRoomId = '';
    const reads = new Map<string, unknown>();
    const f = await fixture(async (context) => {
      if (artifactId)
        reads.set(
          context.binding.conversationId,
          await context.executeTool('read_artifact', { artifactId }, `read-${context.runId}`),
        );
      return { text: context.binding.conversationId === aRoomId ? '已阅读资料' : '已检查权限' };
    });
    const a = await f.context('资料核查');
    const b = await f.context('其他事项');
    aRoomId = a.conversationId;
    const upload = (await f.core.request('conversations.attachBytes', {
      conversationId: f.homeId,
      name: '核查资料.txt',
      mimeType: 'text/plain',
      data: Buffer.from('本次核查的专属资料').toString('base64'),
    })) as { artifact: Artifact };
    artifactId = upload.artifact.id;
    const own = await send(f.core, {
      content: '请核查资料',
      targetContextId: a.id,
      artifactIds: [artifactId],
    });
    await completed(f.core, own.taskIds[0]);
    expect(JSON.stringify(reads.get(aRoomId))).toContain('本次核查的专属资料');
    const other = await send(f.core, { content: '检查其他事项权限', targetContextId: b.id });
    await completed(f.core, other.taskIds[0]);
    expect(JSON.stringify(reads.get(b.conversationId))).toContain('未授权');
    const member = f.bot('成员', ['read_artifact']);
    const group = f.core.entities.createConversation({
      name: '成员群',
      kind: 'group',
      memberIds: [member.id],
      chiefId: member.id,
      workspaceId: a.workspaceId,
    });
    const groupSent = (await f.core.request('conversations.send', {
      conversationId: group.id,
      content: '核查读取权限',
    })) as { taskIds: string[] };
    await completed(f.core, groupSent.taskIds[0]);
    expect(JSON.stringify(reads.get(group.id))).toContain('未授权');
    expect(f.core.state.storage.get<Artifact>('artifacts', artifactId)?.conversationId).toBe(
      f.homeId,
    );
    expect(f.core.state.storage.getMessage(own.messageId)?.artifactIds).toEqual([artifactId]);
  });

  it('自然输入在空工具后台运行中选择续接、新事项或澄清后真实派发', async () => {
    let aId = '',
      bWorkspaceId = '',
      freshId = '';
    const routeCalls: RunContext[] = [];
    const f = await fixture(async (context) => {
      if (context.binding.purpose === 'chief-routing') {
        routeCalls.push(context);
        expect(context.tools).toEqual([]);
        expect(context.userInput).toBeUndefined();
        const request = JSON.parse(context.prompt) as { message: string };
        if (request.message.includes('继续核查'))
          return { text: JSON.stringify({ action: 'continue', contextId: aId }) };
        if (request.message.includes('开始项目B'))
          return {
            text: JSON.stringify({ action: 'new', title: 'B的工作', workspaceId: bWorkspaceId }),
          };
        return {
          text: JSON.stringify({
            action: 'clarify',
            question: '要修改哪个事项？',
            candidateContextIds: [aId, freshId],
          }),
        };
      }
      return { text: '对应事项处理完成' };
    });
    const a = await f.context('已有核查');
    aId = a.id;
    bWorkspaceId = (await f.project('项目B')).id;
    const first = await send(f.core, { content: '继续核查最新条目' });
    const firstInput = await dispatched(f.core, first);
    expect(firstInput.contextId).toBe(a.id);
    await completed(f.core, firstInput.taskIds[0]);
    const second = await send(f.core, { content: '开始项目B的独立工作' });
    const secondInput = await dispatched(f.core, second);
    freshId = secondInput.contextId!;
    expect(f.core.chief.contexts.current(freshId).room.workspaceId).toBe(bWorkspaceId);
    await completed(f.core, secondInput.taskIds[0]);
    const unclear = await send(f.core, { content: '调整那个文件' });
    await eventually(() => input(f.core, unclear.inputId).status === 'clarification');
    expect(input(f.core, unclear.inputId).taskIds).toEqual([]);
    expect(f.core.state.storage.getMessage(unclear.messageId)).toBeUndefined();
    await f.core.request('chief.inputs.resolve', { id: unclear.inputId, contextId: a.id });
    const resolved = await dispatched(f.core, unclear);
    await completed(f.core, resolved.taskIds[0]);
    expect(resolved.contextId).toBe(a.id);
    expect(routeCalls).toHaveLength(3);
    expect(f.core.state.storage.getMessage(unclear.messageId)?.content).toBe('调整那个文件');
    expect(input(f.core, unclear.inputId).content).toBeUndefined();
  });

  it('路由失败后原输入可重试，相同请求只产生一次业务派发', async () => {
    let attempts = 0,
      workCalls = 0;
    const f = await fixture(async (context) => {
      if (context.binding.purpose === 'chief-routing') {
        attempts++;
        return {
          text:
            attempts === 1
              ? '本次识别输出无效'
              : JSON.stringify({ action: 'new', title: '重试事项' }),
        };
      }
      workCalls++;
      return { text: '重试后完成' };
    });
    const fields = { content: '整理本次报告', requestId: 'persistent-input' };
    const first = await send(f.core, fields);
    const same = await send(f.core, fields);
    expect(same.inputId).toBe(first.inputId);
    expect(same.messageId).toBe(first.messageId);
    await eventually(() => input(f.core, first.inputId).status === 'failed');
    expect(input(f.core, first.inputId).content).toBe(fields.content);
    expect(f.core.state.storage.getMessage(first.messageId)).toBeUndefined();
    await f.core.request('chief.inputs.retry', { id: first.inputId });
    const restored = await dispatched(f.core, first);
    await completed(f.core, restored.taskIds[0]);
    const repeated = await send(f.core, fields);
    expect(repeated.taskIds).toEqual(restored.taskIds);
    expect(attempts).toBe(2);
    expect(workCalls).toBe(1);
    expect(
      f.core.state.storage.messages().filter((message) => message.id === first.messageId),
    ).toHaveLength(1);
    await expect(send(f.core, { ...fields, content: '不同内容' })).rejects.toThrow('不匹配');
  });

  it('统一时间线跨原会话分页，并把已读准确写回各自来源', async () => {
    let answers = 0;
    const f = await fixture(async () => ({ text: `独立回复${++answers}` }));
    const contexts = [
      await f.context('甲事项'),
      await f.context('乙事项'),
      await f.context('丙事项'),
    ];
    const replies: Message[] = [];
    for (const [index, context] of contexts.entries()) {
      const sent = await send(f.core, {
        content: `独立用户消息${index}`,
        targetContextId: context.id,
      });
      await completed(f.core, sent.taskIds[0]);
      replies.push(
        f.core.state.storage
          .messages(context.conversationId)
          .find((message) => message.authorType === 'bot' && message.status === 'committed')!,
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
      [...collected].map((message) => message.chiefTimelineSequence).sort((a, b) => a! - b!),
    );
    const snapshot = (await f.core.request('state.snapshot')) as Snapshot;
    expect(snapshot.conversations.find((room) => room.id === f.homeId)?.unreadCount).toBe(3);
    await f.core.request('chief.timeline.read', { messageIds: [replies[0].id] });
    expect(
      f.core.state.storage.metadata<{ sequence: number }>(
        `conversation-read:${contexts[0].conversationId}`,
      )?.sequence,
    ).toBe(replies[0].sequence);
    expect(
      f.core.state.storage.metadata<{ sequence: number }>(
        `conversation-read:${contexts[1].conversationId}`,
      )?.sequence ?? 0,
    ).toBe(0);
    await f.core.request('conversations.read', { id: f.homeId, messageIds: [replies[1].id] });
    const after = (await f.core.request('state.snapshot')) as Snapshot;
    expect(after.conversations.find((room) => room.id === f.homeId)?.unreadCount).toBe(1);
    for (const reply of replies)
      expect(f.core.state.storage.getMessage(reply.id)?.sequence).toBe(reply.sequence);
    const view = (await f.core.request('state.view', { conversationId: f.homeId })) as {
      snapshot: Snapshot;
    };
    expect(view.snapshot.messages.map((message) => message.id)).toEqual(
      collected.map((message) => message.id),
    );
  });

  it('从自然语言找到旧任务候选，续接新工作段并保留原消息和来源', async () => {
    let legacyId = '',
      legacyTaskId = '',
      resumed = false;
    const f = await fixture(async (context) => {
      if (context.binding.purpose === 'chief-routing') {
        const request = JSON.parse(context.prompt) as {
          history: { conversationId: string; taskId?: string }[];
        };
        expect(request.history).toContainEqual(
          expect.objectContaining({ conversationId: legacyId, taskId: legacyTaskId }),
        );
        return {
          text: JSON.stringify({
            action: 'new',
            legacyConversationId: legacyId,
            legacyTaskId,
            title: '继续预算报告',
          }),
        };
      }
      resumed = true;
      expect(context.prompt).toContain('此前预算已完成复核');
      expect(context.prompt).toContain('预算报告');
      return { text: '已接续旧预算报告' };
    });
    legacyId = 'legacy-report';
    legacyTaskId = 'legacy-task';
    const home = f.core.state.storage.get<Conversation>('conversations', f.homeId)!;
    const legacy: Conversation = {
      ...home,
      id: legacyId,
      name: '昨天的预算报告',
      chiefRole: 'history',
      chiefContextId: undefined,
    };
    f.core.state.storage.put('conversations', legacy);
    const original = f.core.state.storage.appendMessage({
      id: 'legacy-source',
      conversationId: legacyId,
      authorType: 'user',
      content: '预算报告',
      artifactIds: [],
      status: 'committed',
      createdAt: '2026-10-23T10:00:00.000Z',
    });
    f.core.state.storage.put('tasks', {
      id: legacyTaskId,
      conversationId: legacyId,
      botId: home.chiefId!,
      goal: '预算报告',
      expectedOutput: '核对预算',
      status: 'completed',
      runIds: [],
      artifactIds: [],
      dependencyIds: [],
      result: '此前预算已完成复核',
      sourceMessageId: original.id,
      requestId: 'legacy-request',
      depth: 0,
      createdAt: original.createdAt,
      updatedAt: original.createdAt,
    } satisfies Task);
    f.core.state.changed();
    const history = (await f.core.request('chief.history.search', {
      query: '预算报告',
    })) as ChiefHistorySearchResult;
    expect(history.items).toContainEqual(
      expect.objectContaining({ messageId: original.id, taskId: legacyTaskId }),
    );
    const sent = await send(f.core, { content: '继续昨天那个预算报告' });
    const saved = await dispatched(f.core, sent);
    await completed(f.core, saved.taskIds[0]);
    expect(resumed).toBe(true);
    const current = f.core.chief.contexts.current(saved.contextId!);
    expect(current.room.id).not.toBe(legacyId);
    expect(current.context).toMatchObject({ legacyConversationId: legacyId, legacyTaskId });
    expect(current.part.sourceMessageIds).toContain(original.id);
    expect(f.core.state.storage.getMessage(original.id)).toEqual(original);
    const timeline = (await f.core.request('chief.timeline.page')) as ChiefTimelinePage;
    expect(timeline.messages.some((message) => message.id === original.id)).toBe(false);
  });
});
