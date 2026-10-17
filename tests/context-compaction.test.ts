import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import type { ContextCheckpoint, Message, SessionBinding, Task } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { CONTEXT_COMPATIBILITY_VERSION, ContextManager, contextCompatibilityHash, contextSourceHash } from '../src/runtime/context.js';
import { estimateTextTokens, estimateTokens, type ModelHistoryEntry } from '../src/runtime/model-history.js';
import { summarizeUnits } from '../src/runtime/context-summary.js';
import { compactRunMessages } from '../src/runtime/run-compaction.js';
import { needsRuntimeContext, runtimeContextMessage } from '../src/core/run-runtime-context.js';
import { runPrompt } from '../src/core/run-prompt.js';
import { ContextReferences } from '../src/core/context-references.js';
import { setup } from './core-harness.js';

describe('D1-D3 上下文估算、稳定记忆前缀与摘要前超大工具投影', () => {
  it('D1: JSON 与代码符号密集文本的 Token 估算高于纯字母散文，且升级上下文兼容版本触发旧检查点重算', async () => {
    const prose = 'word '.repeat(80); // 400 chars of letters + spaces
    const jsonDense = '{"k":1,"a":[2,3],"o":{"x":"y"}}\n'.repeat(12) + '{"k":1,"a":[2,3]}'; // 401 chars
    const codeDense = 'if(a&&b){fn(x[0],y[1]);return z?.w??0;}\n'.repeat(10); // 400 chars

    const proseTokens = estimateTextTokens(prose);
    const jsonTokens = estimateTextTokens(jsonDense.slice(0, 400));
    const codeTokens = estimateTextTokens(codeDense);

    expect(proseTokens).toBe(100);
    expect(jsonTokens).toBeGreaterThan(proseTokens * 1.4);
    expect(codeTokens).toBeGreaterThan(proseTokens * 1.3);
    expect(estimateTokens(jsonDense.slice(0, 400))).toBe(jsonTokens);

    expect(CONTEXT_COMPATIBILITY_VERSION).toBeGreaterThanOrEqual(3);

    const binding: SessionBinding = {
      id: 'binding-d1', botId: 'bot-a', conversationId: 'room-d1', connectionId: 'conn',
      generation: 1, configRevision: 1, connectionRevision: 1, workspaceId: 'ws', lastDeliveredSequence: 0,
    };
    const messages: Message[] = [
      { id: 'm1', conversationId: 'room-d1', sequence: 1, authorType: 'user', content: '旧资料'.repeat(250), artifactIds: [], status: 'committed', createdAt: '2026-10-17T00:00:00Z' },
      { id: 'm2', conversationId: 'room-d1', sequence: 2, authorType: 'user', content: '最新问题', artifactIds: [], status: 'committed', createdAt: '2026-10-17T00:01:00Z' },
    ];
    const legacyV2Hash = createHash('sha256')
      .update(JSON.stringify({ version: 2, instructions: '使用中文', tools: [], protocol: 'responses' }))
      .digest('hex');
    expect(contextCompatibilityHash({ instructions: '使用中文', tools: [], protocol: 'responses' })).not.toBe(legacyV2Hash);

    let saved: ContextCheckpoint | undefined = {
      id: 'cp-legacy',
      bindingId: binding.id,
      generation: 1,
      throughSequence: 1,
      content: '旧版 v2 检查点摘要',
      sourceMessageIds: ['m1'],
      estimatedTokens: 20,
      createdAt: '2026-10-17T00:00:00Z',
      ...({ instructionsHash: legacyV2Hash, sourceHash: contextSourceHash([messages[0]]) } as Record<string, unknown>),
    };
    const manager = new ContextManager({
      getCheckpoint: () => saved,
      saveCheckpoint: cp => { saved = cp; },
    });

    let recomputed = false;
    const prepared = await manager.prepare({
      binding,
      messages,
      instructions: '使用中文',
      protocol: 'responses',
      tools: [],
      contextWindow: 1200,
      triggerTokens: 500,
      force: false,
      signal: new AbortController().signal,
      summarize: async () => {
        recomputed = true;
        return '新版 v3 重新计算的摘要';
      },
    });
    expect(recomputed).toBe(true);
    expect(prepared.messages[0].content).toContain('新版 v3 重新计算的摘要');
  });

  it('D2: 选入相同记忆集合但相关性排序交换时，runtimeContextMessage 输出与版本哈希完全一致', async () => {
    const msgOrderAB = runtimeContextMessage({
      identity: { source: 'bots', id: 'bot-1', name: '助手', role: '研发' },
      conversation: { source: 'conversations', id: 'room-1', name: '项目' },
      members: [
        { source: 'bots', id: 'bot-2', name: '成员乙' },
        { source: 'bots', id: 'bot-1', name: '助手' },
      ],
      memories: [
        { source: 'memory_entries', id: 'mem-b', revision: 1, topic: '测试', content: '使用 Vitest 运行测试' },
        { source: 'memory_entries', id: 'mem-a', revision: 1, topic: '数据库', content: '使用 SQLite 存储状态' },
        { source: 'memory_entries', id: 'mem-pin', revision: 1, pinned: true, topic: '核心', content: '保持单向依赖' },
      ],
      memoryDirectory: {
        totalRemaining: 2,
        hasMore: false,
        hint: '其他获准记忆',
        topics: [
          { topic: '部署规范', count: 1, summary: '构建前校验摘要', ids: ['mem-d2', 'mem-d1'] },
          { topic: '安全策略', count: 1, summary: '禁止硬编码凭据', ids: ['mem-s1'] },
        ],
      },
    });

    const msgOrderBA = runtimeContextMessage({
      identity: { source: 'bots', id: 'bot-1', name: '助手', role: '研发' },
      conversation: { source: 'conversations', id: 'room-1', name: '项目' },
      members: [
        { source: 'bots', id: 'bot-1', name: '助手' },
        { source: 'bots', id: 'bot-2', name: '成员乙' },
      ],
      memories: [
        { source: 'memory_entries', id: 'mem-a', revision: 1, topic: '数据库', content: '使用 SQLite 存储状态' },
        { source: 'memory_entries', id: 'mem-pin', revision: 1, pinned: true, topic: '核心', content: '保持单向依赖' },
        { source: 'memory_entries', id: 'mem-b', revision: 1, topic: '测试', content: '使用 Vitest 运行测试' },
      ],
      memoryDirectory: {
        totalRemaining: 2,
        hasMore: false,
        hint: '其他获准记忆',
        topics: [
          { topic: '安全策略', count: 1, summary: '禁止硬编码凭据', ids: ['mem-s1'] },
          { topic: '部署规范', count: 1, summary: '构建前校验摘要', ids: ['mem-d1', 'mem-d2'] },
        ],
      },
    });

    expect(msgOrderAB.appContext?.version).toBe(msgOrderBA.appContext?.version);
    expect(msgOrderAB.content).toBe(msgOrderBA.content);
    expect(needsRuntimeContext([msgOrderAB], msgOrderBA)).toBe(false);

    // End-to-end verification through runPrompt when query term order flips relevance ranking
    const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
    const member = createBot('架构师', ['recall_memory']);
    const room = core.entities.createConversation({
      name: '架构评审',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const memAlpha = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '数据库架构',
      tags: ['sqlite', '存储'],
      content: '数据库迁移必须在事务内原子执行并保留快照。',
    });
    const memBeta = core.memories.save({
      scope: 'bot',
      ownerId: member.id,
      allowedConversationIds: [room.id],
      topic: '接口契约',
      tags: ['rpc', '接口'],
      content: 'RPC 接口返回值必须保持向后兼容。',
    });

    const tools = { skills: [] } as unknown as ToolExecutionContext;
    const task1: Task = {
      id: 'task-order-1', conversationId: room.id, botId: member.id, dependencyIds: [],
      goal: '请检查 sqlite 数据库架构 与接口契约', expectedOutput: '', status: 'running',
      runIds: [], artifactIds: [], requestId: 'r1', depth: 0, createdAt: '2026-10-17', updatedAt: '2026-10-17',
    };
    const task2: Task = {
      ...task1,
      id: 'task-order-2',
      goal: '请检查 rpc 接口契约 与数据库架构',
      requestId: 'r2',
    };

    const prompt1 = runPrompt(core.state, core.memory, task1, member, room, tools, [], undefined, true);
    const prompt2 = runPrompt(core.state, core.memory, task2, member, room, tools, [], undefined, true);

    expect(prompt1.runtimeContext?.content).toContain(memAlpha.content);
    expect(prompt1.runtimeContext?.content).toContain(memBeta.content);
    expect(prompt1.runtimeContext?.appContext?.version).toBe(prompt2.runtimeContext?.appContext?.version);
    expect(prompt1.runtimeContext?.content).toBe(prompt2.runtimeContext?.content);
    expect(needsRuntimeContext([prompt1.runtimeContext!], prompt2.runtimeContext)).toBe(false);
  });

  it('D3: 超长工具输出进入摘要时先做头尾预览与引用投影，保留首尾结论与引用且不直接截断前 600 字符', async () => {
    const headInfo = '【开头关键信息】执行测试套件：共加载 42 个模块，环境初始化成功。';
    const middleNoise = '中间详细调试日志行：正在逐条扫描语法树节点与依赖图谱...\n'.repeat(600);
    const tailInfo = '【结尾核心结论】全部 128 项断言通过，零错误，构建产物摘要 sha256:9f86d081884c7d659a2feaa0c55ad015。';
    const hugeToolOutput = `${headInfo}\n${middleNoise}\n${tailInfo}`;
    expect(hugeToolOutput.indexOf(tailInfo)).toBeGreaterThan(10000);

    const history: ModelHistoryEntry[] = [
      { sequence: 1, messageId: 'm1', message: { role: 'user', content: '请运行测试并汇报结论' } },
      {
        sequence: 2,
        messageId: 'm2',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-test', name: 'run_command', arguments: JSON.stringify({ command: 'vitest run', workingPath: '/workspace/app' }) }],
        },
      },
      {
        sequence: 2,
        messageId: 'm2',
        message: {
          role: 'tool',
          callId: 'call-test',
          contextArtifactIds: ['artifact-log-001'],
          content: hugeToolOutput,
        },
      },
    ];

    const summaryPrompts: string[] = [];
    const summary = await summarizeUnits(
      history,
      '',
      3000,
      async prompt => {
        summaryPrompts.push(prompt);
        return '测试全部通过，日志已归档。';
      },
      new AbortController().signal,
    );

    expect(summary).toBe('测试全部通过，日志已归档。');
    expect(summaryPrompts).toHaveLength(1);
    expect(summaryPrompts[0]).toContain(headInfo);
    expect(summaryPrompts[0]).toContain(tailInfo);
    expect(summaryPrompts[0]).toContain('artifact-log-001');
    expect(summaryPrompts[0]).toContain('read_artifact');
    expect(summaryPrompts[0]).toContain('/workspace/app');
    expect(summaryPrompts[0].length).toBeLessThan(hugeToolOutput.length / 3);

    // Also verify through ContextReferences + compactRunMessages pipeline
    const { core, bot: createBot } = await setup(async () => ({ text: '完成' }));
    const member = createBot('执行员', ['read_artifact', 'get_task']);
    const room = core.entities.createConversation({
      name: '构建任务',
      kind: 'private',
      memberIds: [member.id],
      workspaceId: core.state.snapshot().workspaces[0].id,
    });
    const task: Task = {
      id: 'task-d3', conversationId: room.id, botId: member.id, status: 'running',
      artifactIds: [], runIds: [], dependencyIds: [], goal: '执行检查', expectedOutput: '',
      requestId: 'req-d3', depth: 0, createdAt: '', updatedAt: '',
    };
    core.state.storage.put('tasks', task);
    const references = new ContextReferences(core.state, {
      runId: 'run-d3', task, bot: member, room,
      toolNames: ['read_artifact', 'get_task'],
      signal: new AbortController().signal,
    });

    const runMessages: ModelMessage[] = [
      { role: 'user', content: '执行检查' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"report.log"}' }] },
      { role: 'tool', callId: 'c1', content: hugeToolOutput },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{"path":"final.txt"}' }] },
      { role: 'tool', callId: 'c2', content: '最新工具结果' },
    ];

    const compactionPrompts: string[] = [];
    const compacted = await compactRunMessages(runMessages, {
      currentStart: 0,
      force: true,
      budget: 4000,
      trigger: 2500,
      fixedTokens: 100,
      protocol: 'responses',
      signal: new AbortController().signal,
      preserveReferences: references.preserveReferences.bind(references),
      summarize: async prompt => {
        compactionPrompts.push(prompt);
        return '早期日志已归档并提取首尾结论。';
      },
    });

    expect(compacted).toBeDefined();
    expect(compactionPrompts).toHaveLength(1);
    expect(compactionPrompts[0]).toContain(headInfo);
    expect(compactionPrompts[0]).toContain(tailInfo);
    expect(compactionPrompts[0]).toContain('read_artifact');
    expect(compacted!.messages.some(msg => msg.contextSummary && msg.contextArtifactIds?.length === 1)).toBe(true);
  });
});
