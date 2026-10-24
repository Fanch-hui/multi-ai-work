import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, Message, Task } from '../src/domain/types.js';
import type { ChiefContextPart, ChiefWorkContext } from '../src/domain/chief-work.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { State } from '../src/core/state.js';
import { ChiefHistoryService } from '../src/core/chief-history.js';
import { createChiefHistoryTools } from '../src/tools/chief-history.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'chief-history-'));
  const state = new State(directory);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => state.storage.db.close());
  const settings = state.settings();
  const home = state.storage.get<Conversation>('conversations', settings.mainConversationId!)!;
  const history = new ChiefHistoryService(state);
  const room = (id: string, change: Partial<Conversation> = {}) =>
    state.storage.put('conversations', {
      ...home,
      id,
      name: id,
      chiefHomeId: home.id,
      chiefRole: 'work',
      ...change,
    } satisfies Conversation);
  const message = (conversationId: string, content: string, change: Partial<Message> = {}) =>
    state.storage.appendMessage({
      id: `message-${Math.random()}`,
      conversationId,
      content,
      authorType: 'user',
      artifactIds: [],
      status: 'committed',
      createdAt: '2026-10-24T12:00:00.000Z',
      ...change,
    });
  return { state, home, history, room, message };
}

describe('管家工作历史', () => {
  it('搜索中文全文、短词和锚点，并隔离其他私聊与群聊', () => {
    const f = fixture();
    const report = f.room('report');
    const own = f.message(report.id, '预算审查结论：合同款项总计 12000 元。');
    const member = f.room('member', { chiefId: 'other', purpose: undefined });
    const group = f.room('group', { kind: 'group' });
    f.message(member.id, '预算审查结论：成员私聊秘密');
    f.message(group.id, '预算审查结论：其他群的资料');
    f.message(f.room('router', { chiefRole: 'router' }).id, '预算审查结论：路由内部资料');
    expect(f.history.search({ query: '预算审查' }).items.map((hit) => hit.messageId)).toEqual([
      own.id,
    ]);
    expect(f.history.search({ query: '合同' }).items.map((hit) => hit.messageId)).toEqual([own.id]);
    expect(f.history.read({ messageId: own.id }).messages[0]).toMatchObject({
      messageId: own.id,
      conversationId: report.id,
      sequence: own.sequence,
      content: '预算审查结论：合同款项总计 12000 元。',
    });
    const hidden = f.message(member.id, '不能跨身份读取');
    expect(() => f.history.read({ messageId: hidden.id })).toThrow('获准');
  });

  it('按事项、项目与日期筛选，返回真实任务和成果来源', () => {
    const f = fixture();
    const room = f.room('report', { chiefContextId: 'context', workspaceId: 'report-workspace' });
    const source = f.message(room.id, '预算审查报告');
    f.state.storage.put('chief_contexts', {
      id: 'context',
      homeConversationId: f.home.id,
      title: '报告预算',
      currentPartId: 'part',
      createdAt: source.createdAt,
    } satisfies ChiefWorkContext);
    f.state.storage.put('chief_parts', {
      id: 'part',
      contextId: 'context',
      conversationId: room.id,
      sourceMessageIds: [],
      sourceArtifactIds: [],
      createdAt: source.createdAt,
    } satisfies ChiefContextPart);
    f.state.storage.put('tasks', {
      id: 'task',
      conversationId: room.id,
      sourceMessageId: source.id,
      botId: room.chiefId!,
      goal: '审查报告专项复核',
      expectedOutput: '',
      status: 'completed',
      runIds: [],
      artifactIds: [],
      dependencyIds: [],
      requestId: 'request',
      depth: 0,
      createdAt: source.createdAt,
      updatedAt: source.createdAt,
    } satisfies Task);
    const result = f.history.search({
      query: '预算',
      contextId: 'context',
      workspaceId: 'report-workspace',
    });
    expect(result.items[0]).toMatchObject({
      contextId: 'context',
      taskId: 'task',
      title: '报告预算',
    });
    expect(f.history.search({ query: '专项复核' }).items[0]).toMatchObject({
      messageId: source.id,
      taskId: 'task',
    });
    expect(f.history.search({ query: '预算', workspaceId: 'elsewhere' }).items).toEqual([]);
    expect(f.history.search({ query: '预算', from: '2026-10-25T00:00:00Z' }).items).toEqual([]);
    expect(f.history.search({ query: '预算', contextId: 'missing' }).items).toEqual([]);
  });

  it('已索引消息修改后立即读取最新内容，删除及权限变化立即失效', () => {
    const f = fixture();
    const room = f.room('report');
    const source = f.message(room.id, '原预算金额 12000');
    expect(f.history.search({ query: '原预算金额' }).items).toHaveLength(1);
    f.state.storage.updateMessage({ ...source, content: '修订预算金额 8000' });
    expect(f.history.search({ query: '原预算金额' }).items).toEqual([]);
    expect(f.history.search({ query: '修订预算金额' }).items[0].content).toContain('8000');
    f.state.storage.put('conversations', { ...room, chiefId: 'other' });
    expect(f.history.search({ query: '修订预算金额' }).items).toEqual([]);
    f.state.storage.put('conversations', room);
    f.state.storage.deleteMessage(source.id);
    expect(f.history.search({ query: '修订预算金额' }).items).toEqual([]);
    expect(() => f.history.read({ messageId: source.id })).toThrow('不存在');
  });

  it('消息和会话反复保存时合并同一个待索引条目', () => {
    const f = fixture();
    const room = f.room('report');
    const source = f.message(room.id, '预算报告初稿');
    f.state.storage.updateMessage({ ...source, content: '预算报告修订' });
    f.state.storage.updateMessage({ ...source, content: '预算报告定稿' });
    f.state.storage.put('conversations', { ...room, name: '预算报告' });
    f.state.storage.put('conversations', { ...room, name: '预算报告定稿' });
    expect(f.history.search({ query: '定稿' }).items[0]).toMatchObject({
      messageId: source.id,
      content: '预算报告定稿',
    });
  });

  it('首次回填有界，未索引消息仍能查询，派生索引可重建', () => {
    const f = fixture();
    const room = f.room('report');
    f.state.storage.db.transaction(() => {
      for (let i = 0; i < 350; i++) f.message(room.id, `普通记录 ${i}`);
    })();
    const target = f.message(room.id, '最后一条独特审查结论');
    expect(f.history.sync(10)).toBe(true);
    const found = f.history.search({ query: '独特审查结论' });
    expect(found.items.map((hit) => hit.messageId)).toEqual([target.id]);
    f.history.rebuild();
    expect(f.history.search({ query: '独特审查结论' }).items[0].messageId).toBe(target.id);
    while (f.history.sync(1000)) {
      /* finish the bounded batches */
    }
    expect(f.history.search({ query: '独特审查结论' }).partial).toBe(false);
  });

  it('原文展开限制输出，普通成员和群聊不提供工作历史工具', () => {
    const f = fixture();
    const source = f.message(f.home.id, '预算'.repeat(30000));
    const result = f.history.read({ messageId: source.id, limit: 15 });
    expect(result.messages.reduce((sum, hit) => sum + hit.content.length, 0)).toBeLessThan(24100);
    const tools = createChiefHistoryTools();
    const callback = () => ({ items: [] });
    const context = {
      conversation: f.home,
      chiefHistory: callback,
    } as unknown as ToolExecutionContext;
    expect(tools.recall_work.available(context)).toBe(true);
    expect(tools.recall_work.available({ ...context, chiefHistory: undefined })).toBe(false);
    expect(
      tools.recall_work.available({ ...context, conversation: { ...f.home, kind: 'group' } }),
    ).toBe(false);
    expect(
      tools.recall_work.available({ ...context, conversation: { ...f.home, purpose: undefined } }),
    ).toBe(false);
    expect(tools.recall_work.execute({}, context)).toEqual({ items: [] });
  });
});
