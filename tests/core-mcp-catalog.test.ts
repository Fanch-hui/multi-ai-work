import { describe, expect, it } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Bot, Task, ToolConnection } from '../src/domain/types.js';
import { remoteToolAlias } from '../src/tools/mcp-catalog.js';
import { eventually, setup } from './core-harness.js';

async function localMcp(directory: string, searchName = 'tavily-search'): Promise<string> {
  const require = createRequire(import.meta.url);
  const url = (name: string) => pathToFileURL(require.resolve(name)).href;
  const script = join(directory, 'tools.mjs');
  await writeFile(script, `
    import { Server } from ${JSON.stringify(url('@modelcontextprotocol/sdk/server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(url('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(url('@modelcontextprotocol/sdk/types.js'))};
    import { appendFile } from 'node:fs/promises';
    const server = new Server({ name: 'work-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'lookup', description: 'Read an item', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
      { name: 'update', description: 'Update an item', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      { name: ${JSON.stringify(searchName)}, description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } }
    ] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const value = { name: request.params.name, arguments: request.params.arguments };
      await appendFile(process.argv[2], JSON.stringify(value) + '\\n');
      const result = request.params.name === ${JSON.stringify(searchName)}
        ? { query: request.params.arguments.query, results: [{ title: 'Source', url: 'https://example.com/source', content: 'Verified result' }] }
        : value;
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    await server.connect(new StdioServerTransport());
  `);
  return script;
}

async function configure(core: Awaited<ReturnType<typeof setup>>['core'], root: string, label = 'search', searchName = 'tavily-search') {
  return core.entities.saveTool({ name: label, kind: 'mcp', enabled: true, transport: 'stdio',
    command: process.execPath, args: [await localMcp(root, searchName), join(root, `${label}.calls`)] });
}

describe('Core MCP 目录及搜索', () => {
  it('注册已授权的真实工具别名，审批和撤销授权仍由 Core 执行', async () => {
    let member!: Bot, tool!: ToolConnection;
    let ready!: () => void, proceed!: () => void;
    const running = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { proceed = resolve; });
    const { core, root, bot } = await setup(async context => {
      const lookup = remoteToolAlias(tool, 'lookup');
      const update = remoteToolAlias(tool, 'update');
      expect(context.tools.find(item => item.name === lookup)?.inputSchema).toMatchObject({ required: ['query'] });
      expect(context.tools.filter(item => item.name.startsWith('mcp__'))).toHaveLength(3);
      expect(await context.executeTool(lookup, { query: '資料' }, 'read')).toHaveProperty('content');
      expect(await context.executeTool(update, {}, 'approve')).toHaveProperty('content');
      expect(await context.executeTool(update, {}, 'deny')).toHaveProperty('error');
      ready(); await resume;
      await expect(context.executeTool(lookup, { query: 'revoked' }, 'revoked')).rejects.toThrow('未授权');
      return { text: '已验证权限' };
    });
    tool = await configure(core, root);
    member = bot('工具助手', ['call_mcp']);
    core.state.storage.put('bots', { ...member, toolConnectionIds: [tool.id] });
    const room = core.entities.createConversation({ name: '工具', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '使用工具' });
    await eventually(() => core.state.snapshot().approvals.some(item => item.status === 'pending'), 10000);
    core.approvals.resolve(core.state.snapshot().approvals.find(item => item.status === 'pending')!.id, true);
    await eventually(() => core.state.snapshot().approvals.filter(item => item.status === 'pending').length === 1);
    core.approvals.resolve(core.state.snapshot().approvals.find(item => item.status === 'pending')!.id, false);
    await running;
    core.state.storage.put('bots', { ...member, toolConnectionIds: [] }); proceed();
    await eventually(() => core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status === 'completed');
    const operations = core.state.storage.all<{ name: string; status: string }>('tool_operations');
    expect(operations.map(item => [item.name, item.status])).toEqual([
      ['call_mcp', 'succeeded'], ['call_mcp', 'succeeded'], ['call_mcp', 'failed']
    ]);
    expect(core.state.storage.events().filter(item => item.type === 'tool').some(item => item.data.name === remoteToolAlias(tool, 'lookup'))).toBe(true);
    expect((await readFile(join(root, 'search.calls'), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it.each(['tavily-search', 'tavily_search'])('Tavily %s 使用 query 参数，明确连接优先于默认连接，未授权默认不扩大权限', async searchName => {
    let first!: ToolConnection, second!: ToolConnection;
    const { core, root, bot } = await setup(async context => {
      const defaultResult = await context.executeTool('search_web', { query: '默认服务' }, 'default') as Record<string, unknown>;
      expect(defaultResult).toMatchObject({ query: '默认服务', connectionId: second.id, backend: 'tavily', service: 'second' });
      expect(defaultResult.sources).toEqual([{ url: 'https://example.com/source', title: 'Source' }]);
      const explicit = await context.executeTool('search_web', { query: '指定服务', connectionId: first.id }, 'explicit');
      expect(explicit).toMatchObject({ connectionId: first.id });
      const current = core.state.storage.get<Bot>('bots', context.bot.id)!;
      core.state.storage.put('bots', { ...current, toolConnectionIds: [first.id] });
      expect(await context.executeTool('search_web', { query: '唯一授权' }, 'sole')).toMatchObject({ connectionId: first.id });
      await expect(context.executeTool('search_web', { query: '越权', connectionId: second.id }, 'denied')).rejects.toThrow('未授权');
      return { text: '已验证搜索路由' };
    });
    first = await configure(core, root, 'first', searchName); second = await configure(core, root, 'second', searchName);
    await core.request('settings.save', { input: { defaultSearchConnectionId: second.id } });
    const member = bot('搜索助手', ['call_mcp', 'search_web']);
    core.state.storage.put('bots', { ...member, toolConnectionIds: [first.id, second.id] });
    const room = core.entities.createConversation({ name: '搜索', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '检索' });
    await eventually(() => ['completed', 'failed'].includes(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status ?? ''), 10000);
    const completed = core.state.storage.get<Task>('tasks', sent.taskIds[0])!;
    expect(completed.status, completed.error).toBe('completed');
    const requests = (await readFile(join(root, 'first.calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests).toEqual([
      { name: searchName, arguments: { query: '指定服务' } },
      { name: searchName, arguments: { query: '唯一授权' } }
    ]);
    expect(core.state.storage.all<{ name: string; result?: { connectionId: string } }>('tool_operations').map(item => item.result?.connectionId))
      .toEqual([second.id, first.id, first.id]);
  });

  it('多个授权搜索服务未设默认时要求明确选择，并列出可选连接', async () => {
    let first!: ToolConnection, second!: ToolConnection;
    const { core, root, bot } = await setup(async context => {
      await expect(context.executeTool('search_web', { query: '资料' }, 'ambiguous')).rejects.toThrow(`first (${first.id})`);
      await expect(context.executeTool('search_web', { query: '资料' }, 'ambiguous-again')).rejects.toThrow(`second (${second.id})`);
      return { text: '需要选择搜索服务' };
    });
    first = await configure(core, root, 'first'); second = await configure(core, root, 'second');
    const member = bot('搜索助手', ['call_mcp', 'search_web']);
    core.state.storage.put('bots', { ...member, toolConnectionIds: [first.id, second.id] });
    const room = core.entities.createConversation({ name: '搜索', kind: 'private', memberIds: [member.id], workspaceId: core.state.snapshot().workspaces[0].id });
    const sent = core.tasks.send({ conversationId: room.id, content: '检索' });
    await eventually(() => ['completed', 'failed'].includes(core.state.storage.get<Task>('tasks', sent.taskIds[0])?.status ?? ''), 10000);
    expect(core.state.storage.get<Task>('tasks', sent.taskIds[0])).toMatchObject({ status: 'completed' });
    expect(core.state.storage.all('tool_operations')).toHaveLength(0);
  });
});
