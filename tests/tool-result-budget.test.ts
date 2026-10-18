import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManagedProgress, ModelMessage, RunContext } from '../src/domain/provider.js';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import { ContextReferences } from '../src/core/context-references.js';
import { prepareToolResultBudget } from '../src/core/tool-result-budget.js';
import { completeToolBatch } from '../src/providers/managed/loop-tools.js';
import { ManagedRunState } from '../src/providers/managed/progress.js';
import { estimateModelMessageTokens, estimateModelMessagesTokens } from '../src/runtime/model-history.js';
import { projectToolResult, toolResultBudgets } from '../src/runtime/tool-result-budget.js';
import { setup } from './core-harness.js';
import { projectSummaryToolMessage } from '../src/runtime/context-summary.js';
import { toolResultMessage } from '../src/runtime/tool-result-message.js';

async function fixture(tools = ['read_file', 'read_artifact'], budget = 20000) {
  const { core, root, bot, connection } = await setup(async () => ({ text: '完成' }));
  const member = bot('助手', tools), workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({ name: '资料', kind: 'private', memberIds: [member.id], workspaceId: workspace.id });
  const task: Task = { id: 'task', conversationId: room.id, botId: member.id, status: 'running', artifactIds: [], runIds: [],
    dependencyIds: [], goal: '读取资料', expectedOutput: '', requestId: 'task', depth: 0, createdAt: '', updatedAt: '' };
  const run: Run = { id: 'run', taskId: task.id, botId: member.id, bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '' };
  core.state.storage.put('tasks', task); core.state.storage.put('runs', run);
  const signal = new AbortController().signal;
  const references = new ContextReferences(core.state, { runId: run.id, task, bot: member, room, toolNames: tools, signal });
  const toolContext = core.tools.context(run, task, member, room, workspace, signal);
  const context: RunContext = { runId: run.id, bot: member, connection, binding: {} as RunContext['binding'], workspacePath: workspace.path,
    prompt: '读取资料', messages: [], instructions: '', tools: core.tools.definitions(toolContext, member), parallelToolNames: ['read_file'],
    signal, nativeMcp: { command: '', args: [], env: {} }, emit: () => {}, persistBinding: () => {},
    getSecret: async () => undefined, saveSecret: async () => {},
    executeTool: (name, args, callId) => core.tools.execute(name, args, callId, toolContext, member) };
  context.prepareToolResults = prepareToolResultBudget(context, references, budget);
  return { core, root, member, task, references, toolContext, context };
}

function batch(contents: string[]): ModelMessage[] {
  return [{ role: 'user', content: '读取资料' }, { role: 'assistant', content: '', toolCalls: contents.map((_content, index) => ({
    id: `${index}`, name: 'read_file', arguments: '{}' })) }, ...contents.map((content, index) => ({ role: 'tool' as const, callId: `${index}`, content }))];
}

describe('工具结果 token 预算', () => {
  it('批量成果分别保留原文和分页坐标，重复投影与摘要不生成成果链', async () => {
    const { core, context, references } = await fixture();
    const first = await references.preserveToolOutput({ role: 'tool', content: '甲'.repeat(18000) });
    const second = await references.preserveToolOutput({ role: 'tool', content: '乙'.repeat(22000) });
    const args = { reads: [{ artifactId: first!.id, offset: 1000, limit: 10000 },
      { artifactId: 'missing' }, { artifactId: second!.id, offset: 2000, limit: 10000 }] };
    const raw = await context.executeTool('read_artifact', args, 'many');
    const messages: ModelMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'many', name: 'read_artifact',
      arguments: JSON.stringify(args) }] }, toolResultMessage('many', raw)];
    const next = await context.prepareToolResults!(messages, 1);
    expect(estimateModelMessageTokens(next![1])).toBeLessThanOrEqual(toolResultBudgets(20000).single);
    const result = JSON.parse(next![1].content);
    expect(result.reads[0]).toMatchObject({ artifactId: first!.id, offset: 1000, nextOffset: 9000, totalLength: 18000 });
    expect(result.reads[1]).toMatchObject({ artifactId: 'missing', error: expect.any(String) });
    expect(result.reads[2]).toMatchObject({ artifactId: second!.id, offset: 2000, totalLength: 22000 });
    for (const index of [0, 2]) {
      const page = result.reads[index];
      expect(page.fullResult.arguments.artifactId).toBe(page.artifactId);
      expect(page.previewOmission.offset).toBeGreaterThan(page.offset);
      const back = await context.executeTool('read_artifact', page.fullResult.arguments, `back-${index}`) as { content: string };
      expect(back.content.startsWith(index === 0 ? '甲' : '乙')).toBe(true);
    }
    const preserved = await references.preserveReferences([next![1]]);
    expect(new Set(preserved.artifactIds)).toEqual(new Set([first!.id, second!.id]));
    const summary = projectSummaryToolMessage(next![1], 20000);
    expect(JSON.parse(summary.content).reads.map((page: { artifactId: string }) => page.artifactId)).toEqual([first!.id, 'missing', second!.id]);
    expect(core.state.storage.all('artifacts')).toHaveLength(2);
    const smaller = await prepareToolResultBudget(context, references, 10000)(next!, 1);
    expect(smaller![1].contextArtifactIds).toEqual(next![1].contextArtifactIds);
    expect(core.state.storage.all('artifacts')).toHaveLength(2);
  });

  it('批量读取原始记录在后续压缩中仍定位每份成果', async () => {
    const { core, context, references } = await fixture();
    const refs = await Promise.all(['甲', '乙'].map(content => references.preserveToolOutput({ role: 'tool', content: content.repeat(5000) })));
    const args = { reads: refs.map(ref => ({ artifactId: ref!.id, limit: 1200 })) };
    const raw = await context.executeTool('read_artifact', args, 'raw-batch');
    const message = toolResultMessage('raw-batch', raw);
    const preserved = await references.preserveReferences([message]);
    expect(new Set(preserved.artifactIds)).toEqual(new Set(refs.map(ref => ref!.id)));
    expect(core.state.storage.all('artifacts')).toHaveLength(2);
  });

  it('再次压缩预览复用完整资料，摘要不将预览位置映射到原文', async () => {
    const { core, context, references } = await fixture();
    const messages = batch(['头部' + '完整资料'.repeat(10000) + '尾部']);
    const projected = await context.prepareToolResults!(messages, 2);
    const preview = projected![2], sourceId = preview.contextArtifactIds![0];
    const sourceOffset = JSON.parse(preview.content).fullResult.arguments.offset;
    const preserved = await references.preserveReferences([preview]);
    expect(preserved.artifactIds).toEqual([sourceId]);
    expect(core.state.storage.all('artifacts')).toHaveLength(1);
    const summary = JSON.parse(projectSummaryToolMessage(preview, 1000).content);
    expect(summary.previewOmission).toBeUndefined();
    expect(summary.fullResult.arguments).toMatchObject({ artifactId: sourceId, offset: sourceOffset });
    const smaller = await prepareToolResultBudget(context, references, 5000)(projected!, 2);
    const result = JSON.parse(smaller![2].content);
    expect(result.previewOmission).toBeUndefined();
    expect(result.fullResult.arguments).toMatchObject({ artifactId: sourceId, offset: 0 });
    expect(core.state.storage.all('artifacts')).toHaveLength(1);
    core.state.storage.delete('artifacts', sourceId);
    await references.preserveReferences([preview]);
    expect(core.state.storage.all('artifacts')).toEqual([]);
  });

  it('保留结构元数据、图像和首尾，中文按 token 而非字符分配', () => {
    const image = { artifactId: 'image', mimeType: 'image/png' };
    const original: ModelMessage = { role: 'tool', callId: 'read', images: [image], content: JSON.stringify({
      status: 'completed', error: null, path: '/资料.txt', version: 'version', offset: 1, nextOffset: 20,
      content: `起始${'资料😀'.repeat(8000)}结尾`, text: '重复正文'.repeat(8000), nested: { artifactIds: ['known'] },
    }) };
    const projected = projectToolResult(original, { id: 'full' }, 1800)!;
    expect(projected.images).toEqual([image]);
    expect(estimateModelMessageTokens(projected)).toBeLessThanOrEqual(1800);
    expect(JSON.parse(projected.content)).toMatchObject({ status: 'completed', error: null, path: '/资料.txt', version: 'version',
      offset: 1, nextOffset: 20, nested: { artifactIds: ['known'] }, truncated: true });
    expect(projected.content).not.toContain('重复正文'.repeat(100));
    expect(projected.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(projectToolResult(original, { id: 'full' }, 10)).toBeUndefined();
  });

  it('按原调用顺序控制总预算，完整结果由现有权限读取且只保存一份', async () => {
    const { core, context, references } = await fixture();
    const contents = Array.from({ length: 4 }, (_, index) => `开头${index}${'资料'.repeat(8000)}结尾${index}`);
    const messages = batch(contents), projection = await context.prepareToolResults!(messages, 2);
    expect(projection).toBeDefined();
    expect(projection!.slice(2).map(message => message.callId)).toEqual(['0', '1', '2', '3']);
    const budget = toolResultBudgets(20000);
    expect(estimateModelMessagesTokens(projection!.slice(2))).toBeLessThanOrEqual(budget.batch);
    for (const [index, message] of projection!.slice(2).entries()) {
      expect(estimateModelMessageTokens(message)).toBeLessThanOrEqual(budget.single);
      const result = JSON.parse(message.content);
      expect(result.preview).toContain(`开头${index}`); expect(result.preview).toContain(`结尾${index}`);
      const artifact = core.state.storage.get<Artifact>('artifacts', result.fullResult.arguments.artifactId)!;
      expect(await readFile(artifact.path, 'utf8')).toBe(contents[index]);
      expect(await references.readableArtifact(artifact.id)).toBeDefined();
    }
    const again = await context.prepareToolResults!(messages, 2);
    expect(again).toEqual(projection);
    expect(core.state.storage.all('artifacts')).toHaveLength(4);
  });

  it('read_artifact 保留原分页坐标和中段读取范围，不创建成果链', async () => {
    const { core, context, references } = await fixture();
    const source = await references.preserveToolOutput({ role: 'tool', content: '资料'.repeat(20000) });
    const original = await context.executeTool('read_artifact', { artifactId: source!.id, offset: 1000, limit: 24000 }, 'read') as Record<string, unknown>;
    const messages: ModelMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_artifact',
      arguments: JSON.stringify({ artifactId: source!.id, offset: 1000, limit: 24000 }) }] },
    { role: 'tool', callId: 'read', content: JSON.stringify(original) }];
    const next = await context.prepareToolResults!(messages, 1), result = JSON.parse(next![1].content);
    expect(result).toMatchObject({ artifactId: source!.id, offset: 1000, nextOffset: 25000, totalLength: 40000,
      fullResult: { arguments: { artifactId: source!.id } } });
    expect(result.previewOmission.offset).toBeGreaterThan(1000);
    expect(result.previewOmission.endOffset).toBeLessThan(25000);
    expect(result.fullResult.arguments.offset).toBe(result.previewOmission.offset);
    expect(result.fullResult.arguments.limit).toBeLessThanOrEqual(1000);
    expect(core.state.storage.all('artifacts')).toHaveLength(1);
  });

  it('权限撤销或无法存储时保持原结果，不改变成功的工具操作', async () => {
    const { core, context, references, member, toolContext } = await fixture();
    const original = batch(['资料'.repeat(10000)]);
    core.state.storage.put('bots', { ...member, toolNames: ['read_file'] });
    expect(await context.prepareToolResults!(original, 2)).toBeUndefined();
    expect(core.state.storage.all('artifacts')).toEqual([]);
    core.state.storage.put('bots', member);
    references.preserveToolOutput = async () => { throw new Error('disk failed'); };
    expect(await context.prepareToolResults!(original, 2)).toBeUndefined();
    const path = join(toolContext.workspace.path, 'raw.txt'); await writeFile(path, '资料'.repeat(18000));
    const result = await context.executeTool('read_file', { path }, 'raw') as { content: string; text: string };
    expect(result.content).toBe('资料'.repeat(18000)); expect(result.text).toBe(result.content);
    expect(core.state.storage.get('tool_operations', 'run:raw')).toMatchObject({ status: 'succeeded', result, modelResult: result });
  });

  it('乱序完成仍产生相同预算投影，恢复跳过已完成工具并保留原始协议', async () => {
    const { context } = await fixture();
    const saved: ManagedProgress[] = [], executed: string[] = [];
    context.saveProgress = async progress => { saved.push(structuredClone(progress)); };
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    context.executeTool = async (_name, _args, callId) => {
      executed.push(callId);
      if (callId === '0') await delayed;
      else release();
      return `${callId}${'正文'.repeat(8000)}尾部`;
    };
    const state = new ManagedRunState(context);
    state.messages.push(batch(['', ''])[1]);
    await completeToolBatch(context, state, new Set());
    expect(saved.filter(progress => progress.phase === 'tools').map(progress => progress.messages.at(-1)?.callId)).toEqual(['1', '1']);
    expect(state.messages.slice(2).map(message => message.callId)).toEqual(['0', '1']);
    expect(state.archiveMessages().filter(message => message.role === 'tool').every(message => message.content.length > 10000)).toBe(true);
    const projected = state.messages;
    context.progress = saved.filter(progress => progress.phase === 'tools').at(-1)!;
    const resumed = new ManagedRunState(context);
    await completeToolBatch(context, resumed, new Set(['0', '1']));
    expect(executed).toEqual(['0', '1']); expect(resumed.messages).toEqual(projected);
    expect(saved.at(-1)?.compaction?.archived).toEqual(state.archiveMessages());
  });
});
