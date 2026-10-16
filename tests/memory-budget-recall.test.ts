import { describe, expect, it } from 'vitest';
import type { MemoryEntry, Task } from '../src/domain/types.js';
import { estimateTokens } from '../src/runtime/model-history.js';
import { runPrompt } from '../src/core/run-prompt.js';
import { sessionMemory } from '../src/core/session-memory.js';
import { eventually, setup } from './core-harness.js';

describe('有预算的分层召回与通道同步', () => {
  it('旧偏好在大量新记忆下按任务相关性召回，无关条目进入主题目录且不越权', async () => {
    const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
    const member = createBot('法务顾问', ['recall_memory']);
    const other = createBot('其他成员', ['recall_memory']);
    const workspaceId = core.state.snapshot().workspaces[0].id;
    const room = core.entities.createConversation({ name: '合同审阅', kind: 'private', memberIds: [member.id], workspaceId });
    const secretRoom = core.entities.createConversation({ name: '机密会话', kind: 'private', memberIds: [other.id], workspaceId });

    const oldRule = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '合同规范',
      summary: '争议解决条款默认约定仲裁',
      tags: ['法律', '合同'],
      content: '审阅商业合同时，争议解决条款默认优先采用北京仲裁委员会仲裁。',
    });
    core.state.storage.put('memory_entries', { ...oldRule, updatedAt: '2026-01-01T00:00:00.000Z' });

    const pinnedRule = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '通用原则',
      pinned: true,
      content: '所有结论必须标注条款编号。',
    });

    for (let index = 1; index <= 12; index++) {
      const entry = core.memories.save({
        scope: 'bot',
        ownerId: member.id,
        allowedConversationIds: [room.id],
        topic: index % 2 === 0 ? '排版偏好' : '汇报节奏',
        content: `日常沟通偏好第 ${index} 项：周会纪要采用固定列表模板。`,
      });
      core.state.storage.put('memory_entries', {
        ...entry,
        updatedAt: `2026-09-${String(index).padStart(2, '0')}T00:00:00.000Z`,
      });
    }

    const secretEntry = core.memories.save({
      scope: 'bot',
      ownerId: other.id,
      allowedConversationIds: [secretRoom.id],
      topic: '合同规范',
      content: '机密合同底价不得外传。',
    });

    const selection = core.memory.selectContext(
      { botId: member.id, conversationId: room.id },
      { query: '请帮我审阅这份商业合同的争议解决条款' },
    );

    expect(selection.pinnedEntries.map(entry => entry.id)).toEqual([pinnedRule.id]);
    expect(selection.relevantEntries.map(entry => entry.id)).toContain(oldRule.id);
    expect(selection.fullEntries.map(entry => entry.id)).toEqual([pinnedRule.id, oldRule.id]);
    expect(selection.directory.totalRemaining).toBe(12);
    expect(selection.directory.topics.map(item => item.topic).sort()).toEqual(['排版偏好', '汇报节奏']);
    expect(JSON.stringify(selection)).not.toContain(secretEntry.id);
    expect(JSON.stringify(selection)).not.toContain('机密合同底价');

    // Short 2-char Chinese query & by-ID expansion respect authorization
    const shortHit = core.memory.recall({ botId: member.id, conversationId: room.id }, '合同');
    expect(shortHit.map(entry => entry.id)).toEqual([oldRule.id]);

    const expanded = core.memory.query(
      { botId: member.id, conversationId: room.id },
      { ids: [oldRule.id, secretEntry.id] },
    ) as MemoryEntry[];
    expect(expanded.map(entry => entry.id)).toEqual([oldRule.id]);

    const page = core.memory.query(
      { botId: member.id, conversationId: room.id },
      { topic: '排版偏好', offset: 0, limit: 3 },
    ) as { entries: MemoryEntry[]; total: number; nextOffset: number | null };
    expect(page.total).toBe(6);
    expect(page.entries).toHaveLength(3);
    expect(page.nextOffset).toBe(3);

    // 70+ matching records where the unique target topic is at the oldest position
    for (let index = 13; index <= 80; index++) {
      const filler = core.memories.save({
        scope: 'bot',
        ownerId: member.id,
        allowedConversationIds: [room.id],
        topic: '日常填充',
        content: `商業合同审查补充记录第 ${index} 条：争议解决与一般条款核对。`,
      });
      core.state.storage.put('memory_entries', {
        ...filler,
        updatedAt: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
    const deepTopicHit = core.memory.query(
      { botId: member.id, conversationId: room.id },
      { query: '争议解决', topic: '合同规范', offset: 0, limit: 8 },
    ) as { entries: MemoryEntry[]; total: number };
    expect(deepTopicHit.total).toBe(1);
    expect(deepTopicHit.entries.map(entry => entry.id)).toEqual([oldRule.id]);
  });

  it('整体注入预算受控，超长记忆不截断冒充全文而是提供摘要与展开入口', async () => {
    const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
    const member = createBot('研究员', ['recall_memory']);
    const room = core.entities.createConversation({
      name: '研究',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });

    const shortPinned = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      pinned: true,
      topic: '核心规则',
      content: '引用文献须注明年份与作者。',
    });

    const hugeContent = `详细实验操作规程：${'步骤说明与参数校验要求，必须完整阅读后再执行。'.repeat(50)}`;
    const hugeEntry = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '实验规程',
      summary: '实验操作规程长文说明',
      content: hugeContent,
    });

    const selection = core.memory.selectContext(
      { botId: member.id, conversationId: room.id },
      { query: '实验操作规程', budgetTokens: 320 },
    );

    expect(selection.fullEntries.map(entry => entry.id)).toEqual([shortPinned.id]);
    expect(selection.omittedEntries.map(entry => entry.id)).toEqual([hugeEntry.id]);
    expect(selection.estimatedTokens).toBeLessThanOrEqual(320);

    const formatted = core.memory.instructions(member.id, room.id, { query: '实验操作规程', budgetTokens: 320 });
    expect(formatted).toContain('引用文献须注明年份与作者');
    expect(formatted).toContain('实验操作规程长文说明');
    expect(formatted).toContain('未注入全文');
    expect(formatted).not.toContain(hugeContent.slice(0, 400));
    expect(estimateTokens(formatted)).toBeLessThanOrEqual(320);

    // Near-budget pinned memory (~1,966 tokens in selectContext) falls back to summary in sessionMemory instead of disappearing
    const nearBudgetRoom = core.entities.createConversation({
      name: '临界预算会话',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const nearBudgetEntry = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [nearBudgetRoom.id],
      pinned: true,
      topic: '临界规范',
      summary: '临界预算下的核心规范摘要',
      content: '甲'.repeat(1940),
    });
    const nearSelection = core.memory.selectContext(
      { botId: member.id, conversationId: nearBudgetRoom.id },
      { budgetTokens: 2000 },
    );
    expect(nearSelection.fullEntries.map(entry => entry.id)).toEqual([nearBudgetEntry.id]);
    expect(nearSelection.estimatedTokens).toBeGreaterThan(1940);
    expect(nearSelection.estimatedTokens).toBeLessThanOrEqual(2000);

    const nearTurn = sessionMemory(
      core.memory,
      member,
      {
        id: 'binding-near', botId: member.id, conversationId: nearBudgetRoom.id, connectionId: member.connectionId,
        generation: 1, configRevision: member.revision, connectionRevision: 1, workspaceId: nearBudgetRoom.workspaceId,
        lastDeliveredSequence: 0,
      },
      { budgetTokens: 2000 },
    );
    expect(nearTurn.prompt).toContain('未注入全文的记忆摘要');
    expect(nearTurn.prompt).toContain('临界预算下的核心规范摘要');
    expect(nearTurn.prompt).toContain(nearBudgetEntry.id);
    expect(estimateTokens(nearTurn.prompt)).toBeLessThanOrEqual(2000);
    expect(nearTurn.versions[nearBudgetEntry.id]).toBe(nearBudgetEntry.revision);
  });

  it('区分本轮未选中、正文修订与撤销：managed 不重建历史，native 不误报失效引用且修订补发严格受预算限制', async () => {
    const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
    const member = createBot('助手', ['recall_memory']);
    const room = core.entities.createConversation({
      name: '工作会话',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });

    const budgetRule = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '财务',
      content: '预算核算统一使用人民币。',
    });
    const codeRule = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '研发',
      content: '代码单元测试使用 Vitest。',
    });

    const taskA: Task = {
      id: 'task-a', conversationId: room.id, botId: member.id, dependencyIds: [],
      goal: '请进行预算核算', expectedOutput: '', status: 'running', runIds: [], artifactIds: [],
      requestId: 'req-a', depth: 0, createdAt: '2026-10-16', updatedAt: '2026-10-16',
    };
    const taskB: Task = {
      ...taskA, id: 'task-b', goal: '请编写代码单元测试', requestId: 'req-b',
    };
    const tools = { skills: [] } as never;

    // Managed channel: switching task query updates runtimeContext selection without changing contextInstructions
    const promptA = runPrompt(core.state, core.memory, taskA, member, room, tools, [], undefined, true);
    const promptB = runPrompt(core.state, core.memory, taskB, member, room, tools, [], undefined, true);
    expect(promptA.contextInstructions).toBe(promptB.contextInstructions);
    expect(promptA.runtimeContext?.content).toContain(budgetRule.content);
    expect(promptB.runtimeContext?.content).toContain(codeRule.content);

    // Native channel: unselected entry is NOT marked as removed
    const binding = {
      id: 'binding-1', botId: member.id, conversationId: room.id, connectionId: member.connectionId,
      generation: 1, configRevision: member.revision, connectionRevision: 1, workspaceId: room.workspaceId,
      nativeSessionId: 'native-1', lastDeliveredSequence: 1,
    };
    const turn1 = sessionMemory(core.memory, member, { ...binding, nativeSessionId: undefined }, { query: '预算核算' });
    expect(turn1.prompt).toContain(`[${budgetRule.id}@1]`);
    expect(turn1.versions).toEqual({ [budgetRule.id]: 1 });

    const turn2 = sessionMemory(
      core.memory,
      member,
      { ...binding, memoryVersions: turn1.versions },
      { query: '代码单元测试' },
    );
    expect(turn2.prompt).toContain(`[${codeRule.id}@1]`);
    expect(turn2.prompt).not.toContain('失效的记忆引用');
    expect(turn2.versions).toEqual({ [budgetRule.id]: 1, [codeRule.id]: 1 });

    // Editing previously delivered budgetRule pushes its new revision even if current query focuses on code
    core.memories.save({ ...budgetRule, content: '预算核算统一使用人民币并保留两位小数。' });
    const turn3 = sessionMemory(
      core.memory,
      member,
      { ...binding, memoryVersions: turn2.versions },
      { query: '代码单元测试' },
    );
    expect(turn3.prompt).toContain(`[${budgetRule.id}@2] [财务] 预算核算统一使用人民币并保留两位小数。`);
    expect(turn3.prompt).not.toContain('失效的记忆引用');
    expect(turn3.versions).toEqual({ [budgetRule.id]: 2, [codeRule.id]: 1 });

    // Editing previously delivered budgetRule into an oversized text (>6,000 tokens) must NOT bypass the 2,000-token budget
    const oversizedRevision = `超长财务核算与审计细则：${'每一笔预算支出均须附带完整科目编码、审批流水与复核签名记录。'.repeat(240)}`;
    core.memories.save({
      ...budgetRule,
      summary: '超长财务核算细则摘要',
      content: oversizedRevision,
    });
    const turnOversized = sessionMemory(
      core.memory,
      member,
      { ...binding, memoryVersions: turn3.versions },
      { query: '代码单元测试', budgetTokens: 2000 },
    );
    expect(estimateTokens(turnOversized.prompt)).toBeLessThanOrEqual(2000);
    expect(turnOversized.prompt).toContain('未注入全文');
    expect(turnOversized.prompt).not.toContain(oversizedRevision.slice(0, 300));
    expect(turnOversized.versions[budgetRule.id]).toBe(3);

    // Revoking budgetRule on the continuous path (using turnOversized.versions) still sends invalidation notice
    core.memories.revoke(budgetRule.id);
    const turn4 = sessionMemory(
      core.memory,
      member,
      { ...binding, memoryVersions: turnOversized.versions },
      { query: '代码单元测试' },
    );
    expect(turn4.prompt).toContain(`失效的记忆引用：[${budgetRule.id}]`);
    expect(turn4.versions).toEqual({ [codeRule.id]: 1 });
  });

  it('在真实运行中支持 recall_memory 按 ID 与分页读取，统计不影响正文 revision', async () => {
    let recalledById: MemoryEntry[] = [];
    const { core, bot: createBot } = await setup(async context => {
      recalledById = await context.executeTool('recall_memory', { ids: [saved.id] }, 'expand-id') as MemoryEntry[];
      return { text: '已读取' };
    });
    const member = createBot('成员', ['recall_memory']);
    const room = core.entities.createConversation({
      name: '对话',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const saved = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '风格',
      content: '报告摘要控制在三段以内。',
    });

    const sent = core.tasks.send({ conversationId: room.id, content: '请整理报告' });
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');

    expect(recalledById.map(item => item.id)).toEqual([saved.id]);
    const current = core.state.storage.get<MemoryEntry>('memory_entries', saved.id)!;
    expect(current.revision).toBe(1);
    expect(current.updatedAt).toBe(saved.updatedAt);
  });
});
