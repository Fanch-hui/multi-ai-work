import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Artifact, Run, Task } from '../src/domain/types.js';
import { prepareWebToolResult } from '../src/core/web-tool-result.js';
import { ToolRuntime } from '../src/core/tool-runtime.js';
import { createToolRegistry } from '../src/tools/index.js';
import { setup } from './core-harness.js';

async function fixture(readable = true) {
  const { core, bot } = await setup(async () => ({ text: '完成' }));
  const member = bot('检索助手', ['fetch_web', 'search_web', ...(readable ? ['read_artifact'] : [])]);
  const workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({ name: '检索', kind: 'private', memberIds: [member.id], workspaceId: workspace.id });
  const task: Task = { id: 'web-task', conversationId: room.id, botId: member.id, status: 'running', artifactIds: [], runIds: [],
    dependencyIds: [], goal: '查阅资料', expectedOutput: '', requestId: 'web-task', depth: 0, createdAt: '', updatedAt: '' };
  const run: Run = { id: 'web-run', taskId: task.id, botId: member.id, bindingId: 'binding', status: 'running', configRevision: 1, createdAt: '' };
  core.state.storage.put('tasks', task); core.state.storage.put('runs', run);
  const context = core.tools.context(run, task, member, room, workspace, new AbortController().signal);
  return { core, member, task, context };
}

type Preview = { fullResult: { tool: string; arguments: { artifactId: string; offset: number; limit: number } } };

describe('网页与搜索结果模型摘录', () => {
  it('工具记录保存原文，返回摘录并在重复调用时复用同一结果', async () => {
    const { core, member, context } = await fixture();
    const original = { url: 'https://example.com/article', title: '原始资料', content: '完整正文。'.repeat(3000), links: [] };
    const registry = createToolRegistry();
    let fetches = 0;
    const tools = new ToolRuntime(core.state, { ...registry, execute: async (name, args, input) => {
      if (name !== 'fetch_web') return registry.execute(name, args, input);
      fetches++; return original;
    } }, core.tasks, core.approvals, core.memory, core.team, core.memories);
    try {
      const args = { url: original.url };
      const result = await tools.execute('fetch_web', args, 'fetch', context, member) as Preview;
      expect(result.fullResult.tool).toBe('read_artifact');
      expect(core.state.storage.get('tool_operations', 'web-run:fetch')).toMatchObject({ status: 'succeeded', result: original, modelResult: result });
      expect(await tools.execute('fetch_web', args, 'fetch', context, member)).toEqual(result);
      expect(fetches).toBe(1);
    } finally { await tools.processes.close(); await registry.close(); }
  });

  it('先保存完整网页，正文末尾可按现有权限分页读取，重复准备复用同一资料', async () => {
    const { core, member, task, context } = await fixture();
    const original = { url: 'https://example.com/article', title: '资料', content: `${'正文。'.repeat(30000)}尾部唯一证据`,
      links: [], fetchedAt: '2026-10-18T00:00:00Z', truncated: false };
    const source = JSON.stringify(original);
    const result = await prepareWebToolResult(core.state, context, member, 'fetch_web', {}, original) as Preview;
    expect(JSON.stringify(result).length).toBeLessThan(source.length / 5);
    const artifact = core.state.storage.get<Artifact>('artifacts', result.fullResult.arguments.artifactId)!;
    expect(artifact).toMatchObject({ taskId: task.id, botId: member.id, conversationId: context.conversation.id, purpose: 'intermediate' });
    expect(await readFile(artifact.path, 'utf8')).toBe(source);
    const tail = await core.tools.execute('read_artifact', { artifactId: artifact.id, offset: source.indexOf('尾部唯一证据'), limit: 100 },
      'read-tail', context, member) as { content: string };
    expect(tail.content).toContain('尾部唯一证据');
    expect(await prepareWebToolResult(core.state, context, member, 'fetch_web', {}, original)).toEqual(result);
    expect(core.state.storage.all('artifacts')).toHaveLength(1);
    expect(JSON.stringify(original)).toBe(source);
  });

  it('保存完整搜索记录，同时返回包含来源与日期的短摘录', async () => {
    const { core, member, context } = await fixture();
    const original = { query: '新品发布时间', backend: 'http', fetchedAt: '2026-10-18T00:00:00Z',
      results: { results: [{ title: '官方消息', url: 'https://example.com/news', published_date: '2026-10-17',
        content: '消息摘要。'.repeat(2000), raw_content: '网页全文。'.repeat(10000) }] }, sources: [] };
    const result = await prepareWebToolResult(core.state, context, member, 'search_web', {}, original) as Preview;
    const text = JSON.stringify(result);
    expect(text).toContain('https://example.com/news'); expect(text).toContain('2026-10-17');
    expect(text.length).toBeLessThan(JSON.stringify(original).length / 5);
    const artifact = core.state.storage.get<Artifact>('artifacts', result.fullResult.arguments.artifactId)!;
    expect(JSON.parse(await readFile(artifact.path, 'utf8'))).toEqual(original);
  });

  it('缺少全文读取权限或结果无需缩短时保持原数据', async () => {
    const { core, member, context } = await fixture(false);
    const original = { url: 'https://example.com', content: '正文'.repeat(10000), links: [] };
    expect(await prepareWebToolResult(core.state, context, member, 'fetch_web', {}, original)).toBe(original);
    const enabled = core.entities.saveBot({ ...member, toolNames: [...member.toolNames, 'read_artifact'] });
    const short = { url: 'https://example.com', content: '短正文', links: [] };
    expect(await prepareWebToolResult(core.state, context, enabled, 'fetch_web', {}, short)).toBe(short);
    expect(core.state.storage.all('artifacts')).toHaveLength(0);
  });
});
