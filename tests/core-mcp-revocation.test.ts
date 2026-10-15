import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Run } from '../src/domain/types.js';
import { id, now } from '../src/core/state.js';
import { eventually, setup } from './core-harness.js';

async function fixture(readOnly: boolean) {
  const { core, root, bot } = await setup(async () => ({ text: '完成' }));
  core.scheduler.pause();
  const require = createRequire(import.meta.url);
  const url = (name: string) => pathToFileURL(require.resolve(name)).href;
  const script = join(root, 'server.mjs'), ready = join(root, 'ready'), gate = join(root, 'gate'), calls = join(root, 'calls');
  await writeFile(script, `
    import { Server } from ${JSON.stringify(url('@modelcontextprotocol/sdk/server/index.js'))};
    import { StdioServerTransport } from ${JSON.stringify(url('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(url('@modelcontextprotocol/sdk/types.js'))};
    import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
    const [ready, gate, calls] = process.argv.slice(2);
    const server = new Server({ name: 'revocation-test', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      writeFileSync(ready, 'ready');
      while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 5));
      return { tools: [{ name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: ${readOnly} } }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async request => {
      appendFileSync(calls, 'executed\\n');
      if (request.params.arguments?.disconnect) process.exit(0);
      return { content: [{ type: 'text', text: 'result' }] };
    });
    await server.connect(new StdioServerTransport());
  `);
  const connection = await core.entities.saveTool({ name: '本地工具', kind: 'mcp', enabled: true, transport: 'stdio',
    command: process.execPath, args: [script, ready, gate, calls] });
  const member = core.entities.saveBot({ ...bot('工具成员', ['call_mcp']), toolConnectionIds: [connection.id] });
  const workspace = core.state.snapshot().workspaces[0];
  const room = core.entities.createConversation({ name: '工具', kind: 'private', memberIds: [member.id], workspaceId: workspace.id });
  const task = core.tasks.create({ botId: member.id, conversationId: room.id, goal: '读取资料' });
  const run: Run = { id: id(), taskId: task.id, botId: member.id, bindingId: id(), status: 'running', configRevision: member.revision, createdAt: now() };
  core.state.storage.put('runs', run);
  const context = core.tools.context(run, task, member, room, workspace, new AbortController().signal);
  context.getSecret = async () => undefined;
  return { core, member, connection, ready, gate, calls,
    execute: (args = {}) => core.tools.execute('call_mcp', { connectionId: connection.id, toolName: 'lookup', arguments: args }, id(), context, member) };
}

describe('MCP 派发前授权复核', () => {
  it.each([
    { readOnly: true, revoke: 'connection' },
    { readOnly: true, revoke: 'tool' },
    { readOnly: true, revoke: 'enabled' },
    { readOnly: false, revoke: 'connection' },
  ])('目录初始化等待期间撤销 $revoke，readOnly=$readOnly 不派发远端请求', async ({ readOnly, revoke }) => {
    const f = await fixture(readOnly);
    const executing = f.execute();
    await eventually(() => existsSync(f.ready), 10000);
    if (revoke === 'enabled') await f.core.entities.saveTool({ ...f.connection, enabled: false });
    else f.core.entities.saveBot({ ...f.member, toolConnectionIds: revoke === 'connection' ? [] : [f.connection.id],
      toolNames: revoke === 'tool' ? [] : ['call_mcp'] });
    await writeFile(f.gate, 'continue');
    if (!readOnly) {
      await eventually(() => f.core.state.snapshot().approvals.some(item => item.status === 'pending'));
      f.core.approvals.resolve(f.core.state.snapshot().approvals.find(item => item.status === 'pending')!.id, true);
    }
    expect(await executing).toMatchObject({ error: expect.stringContaining('未授权') });
    expect(existsSync(f.calls)).toBe(false);
    expect(f.core.state.storage.all('tool_operations')).toEqual([expect.objectContaining({ status: 'failed' })]);
    if (readOnly) expect(f.core.state.snapshot().approvals).toEqual([]);
  });

  it('已授权只读请求在远端断开时保留失败状态，不记录未知副作用或审批', async () => {
    const f = await fixture(true);
    await writeFile(f.gate, 'continue');
    expect(await f.execute({ disconnect: true })).toHaveProperty('error');
    expect(await readFile(f.calls, 'utf8')).toBe('executed\n');
    expect(f.core.state.storage.all('tool_operations')).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(f.core.state.snapshot().approvals).toEqual([]);
  });
});
