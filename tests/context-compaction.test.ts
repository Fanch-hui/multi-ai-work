import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/domain/provider.js';
import type { ContextCheckpoint, Message, Run, SessionBinding, Task } from '../src/domain/types.js';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import { CONTEXT_COMPATIBILITY_VERSION, ContextManager, contextCompatibilityHash, contextSourceHash } from '../src/runtime/context.js';
import { estimateTextTokens, estimateTokens, type ModelHistoryEntry } from '../src/runtime/model-history.js';
import { projectSummaryToolMessage, summarizeUnits } from '../src/runtime/context-summary.js';
import { compactRunMessages } from '../src/runtime/run-compaction.js';
import { needsRuntimeContext, runtimeContextMessage } from '../src/core/run-runtime-context.js';
import { runPrompt } from '../src/core/run-prompt.js';
import { ContextReferences } from '../src/core/context-references.js';
import { setup } from './core-harness.js';

async function summaryFixture(tools: string[]) {
  const { core, bot } = await setup(async () => ({ text: '完成' }));
  const member = bot('资料整理员', tools);
  const workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({ name: '摘要资料', kind: 'private', memberIds: [member.id], workspaceId: workspace.id });
  const task: Task = { id: 'summary-task', conversationId: room.id, botId: member.id, status: 'running',
    artifactIds: [], runIds: [], dependencyIds: [], goal: '整理资料', expectedOutput: '', requestId: 'summary-task', depth: 0, createdAt: '', updatedAt: '' };
  const run: Run = { id: 'summary-run', taskId: task.id, botId: member.id, bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '' };
  core.state.storage.put('tasks', task);
  core.state.storage.put('runs', run);
  const signal = new AbortController().signal;
  const references = new ContextReferences(core.state, { runId: run.id, task, bot: member, room, toolNames: tools, signal });
  const context = core.tools.context(run, task, member, room, workspace, signal);
  return { core, member, references, context, signal };
}

describe('D1-D3 上下文估算、稳定记忆前缀与摘要前超大工具投影', () => {
  it('没有获准完整引用时保留中段，正文自报的成果 ID 不作为裁剪依据', async () => {
    const { references, signal } = await summaryFixture(['read_file']);
    const marker = 'MIDDLE_REQUIRED_CONSTRAINT';
    const message: ModelMessage = { role: 'tool', callId: 'read', contextArtifactIds: ['obsolete-reference'],
      content: JSON.stringify({ artifactId: 'unverified-body-id', content: '开头资料'.repeat(450) + marker + '结尾资料'.repeat(450) }) };
    const original = { ...message };
    const working = { ...message };
    expect(await references.preserveReferences([working])).toEqual({ text: '', artifactIds: [] });
    expect(working.contextArtifactIds).toBeUndefined();
    const call = { id: 'read', name: 'read_file', arguments: '{"path":"rules.txt"}' };
    expect(projectSummaryToolMessage(working, 1700, call)).toBe(working);
    const prompts: string[] = [];
    await summarizeUnits([
      { sequence: 1, messageId: 'assistant', message: { role: 'assistant', content: '', toolCalls: [call] } },
      { sequence: 2, messageId: 'tool', message: working },
    ], '', 2600, async prompt => { prompts.push(prompt); return '已保留资料要点'; }, signal);
    expect(prompts.join('\n')).toContain(marker);
    expect(prompts.length).toBeGreaterThan(1);
    expect(message).toEqual(original);
  });

  it('JSON 结果的省略位置对应完整归档字符，旧引用与原始分页偏移保持独立', async () => {
    const { core, member, references, context } = await summaryFixture(['read_artifact']);
    const old: ModelMessage = { role: 'tool', callId: 'old', content: '旧成果内容'.repeat(300) };
    const prior = await references.preserveReferences([old]);
    const content = JSON.stringify({ metadata: '较长元数据'.repeat(500), artifactId: 'body-claimed-id', offset: 700,
      content: '引号"与换行\n以及路径\\目录'.repeat(500), status: 'complete' });
    const message: ModelMessage = { role: 'tool', callId: 'page', content, contextArtifactIds: prior.artifactIds };
    const preserved = await references.preserveReferences([message], prior.artifactIds);
    const archiveId = message.contextArtifactIds![0];
    expect(archiveId).not.toBe(prior.artifactIds[0]);
    expect(message.contextArtifactIds).toContain(prior.artifactIds[0]);
    expect(preserved.artifactIds).toContain(archiveId);
    const call = { id: 'page', name: 'read_artifact', arguments: JSON.stringify({ artifactId: prior.artifactIds[0], offset: 700 }) };
    const projected = JSON.parse(projectSummaryToolMessage(message, 2000, call).content) as {
      offset: number; preview: string; previewOmission: { offset: number; endOffset: number; totalLength: number };
      fullResult: { arguments: { artifactId: string; offset: number; limit: number } };
    };
    const omission = projected.previewOmission;
    expect(projected.offset).toBe(700);
    expect(omission.totalLength).toBe(content.length);
    expect(projected.preview).toBe(`${content.slice(0, omission.offset)}\n[…中间内容已省略，请按完整结果引用读取…]\n${content.slice(omission.endOffset)}`);
    expect(projected.fullResult.arguments).toMatchObject({ artifactId: archiveId, offset: omission.offset });
    const result = await core.tools.execute('read_artifact', projected.fullResult.arguments, 'read-archive-offset', context, member) as { content: string; offset: number; totalLength: number };
    const { offset, limit } = projected.fullResult.arguments;
    expect(result).toMatchObject({ content: content.slice(offset, offset + limit), offset, totalLength: content.length });
    expect(message.content).toBe(content);
    let summaryPrompt = '';
    const original: ModelMessage = { ...message, contextArtifactIds: prior.artifactIds };
    const compacted = await compactRunMessages([{ role: 'assistant', content: '', toolCalls: [call] }, original], {
      currentStart: 0, force: true, budget: 4000, trigger: 600, fixedTokens: 100, protocol: 'responses', signal: context.signal,
      preserveToolOutput: async () => ({ text: '归档资料', artifactIds: [archiveId, ...prior.artifactIds] }),
      summarize: async prompt => { summaryPrompt = prompt; return '已提取结果'; },
    });
    expect(compacted).toBeDefined();
    const records = JSON.parse(summaryPrompt.split('待合并历史：\n')[1]) as ModelMessage[];
    expect(JSON.parse(records.find(record => record.role === 'tool')!.content).fullResult.arguments.artifactId).toBe(archiveId);
    expect(original.contextArtifactIds).toEqual(prior.artifactIds);
  });

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
