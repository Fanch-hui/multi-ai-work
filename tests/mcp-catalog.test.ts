import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import type { ToolConnection } from '../src/domain/types.js';
import { McpConnections } from '../src/tools/mcp.js';
import { remoteToolAlias } from '../src/tools/mcp-catalog.js';

const query = { name: 'query', description: 'Find an item', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } };
const control = { name: 'control', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }, annotations: { readOnlyHint: true } };
const mutation = { name: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } };

describe('MCP remote catalog', () => {
  let directory: string;
  let script: string;
  let catalogPath: string;
  let mcp: McpConnections;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ai-team-mcp-catalog-'));
    script = path.join(directory, 'server.mjs');
    catalogPath = path.join(directory, 'tools.json');
    mcp = new McpConnections();
    const require = createRequire(import.meta.url);
    const moduleUrl = (name: string) => pathToFileURL(require.resolve(name)).href;
    await writeFile(script, `
      import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
      import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
      import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
      import { readFile, writeFile } from 'node:fs/promises';
      const file = process.argv[2]; let lists = 0;
      const server = new Server({ name: 'catalog-test', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: JSON.parse(await readFile(file, 'utf8')), _meta: { lists: ++lists } }));
      server.setRequestHandler(CallToolRequestSchema, async request => {
        if (request.params.name === 'control') {
          const action = request.params.arguments.action;
          if (action === 'disconnect') process.exit(0);
          if (action === 'notify') await server.sendToolListChanged();
          if (action === 'delay') await new Promise(resolve => setTimeout(resolve, 5000));
        }
        return { content: [{ type: 'text', text: JSON.stringify({ name: request.params.name, args: request.params.arguments, lists }) }] };
      });
      await server.connect(new StdioServerTransport());
    `);
    await writeFile(catalogPath, JSON.stringify([query, control, mutation]));
  });

  afterEach(async () => {
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  });

  function connection(id = 'catalog'): ToolConnection {
    return { id, name: '资料', kind: 'mcp', enabled: true, transport: 'stdio', command: process.execPath, args: [script, catalogPath], toolNames: ['outdated'], status: 'ready' };
  }

  function context(connections: ToolConnection[]): ToolExecutionContext {
    return {
      toolConnections: connections, getSecret: async () => undefined, signal: new AbortController().signal,
      requestApproval: vi.fn(async () => false), markDispatched: vi.fn()
    } as unknown as ToolExecutionContext;
  }

  async function callCount(ctx: ToolExecutionContext): Promise<number> {
    const result = await mcp.call('catalog', 'query', { query: 'item' }, ctx) as { content: { text: string }[] };
    return JSON.parse(result.content[0].text).lists;
  }

  it('exposes schemas despite old discovered names and rechecks grants, parameters and approval', async () => {
    const ctx = context([connection()]);
    const tools = await mcp.catalog(ctx);
    expect(ctx.toolConnections[0].toolNames).toEqual(['query', 'control', 'write']);
    const definition = tools.find(item => item.name === remoteToolAlias(ctx.toolConnections[0], 'query'))!;
    expect(definition.inputSchema).toEqual(query.inputSchema);
    expect(definition.description).toContain('Find an item');
    expect(mcp.resolve(definition.name, ctx)).toEqual({ connectionId: 'catalog', toolName: 'query' });
    expect(await mcp.describe('catalog', ctx)).toHaveLength(3);
    await expect(mcp.call('catalog', 'query', { query: 4 }, ctx)).rejects.toThrow('参数无效');
    await expect(mcp.call('catalog', 'write', {}, ctx)).rejects.toThrow('批准');
    expect(ctx.markDispatched).not.toHaveBeenCalled();
    ctx.requestApproval = vi.fn(async () => true);
    await mcp.call('catalog', 'write', {}, ctx);
    expect(ctx.markDispatched).toHaveBeenCalledOnce();
    ctx.toolConnections = [];
    expect(mcp.resolve(definition.name, ctx)).toBeUndefined();
    await expect(mcp.call('catalog', 'query', { query: 'item' }, ctx)).rejects.toThrow('未授权');
  });

  it('refreshes on explicit detection, notifications, configuration changes and reconnect', async () => {
    const ctx = context([connection()]);
    await mcp.catalog(ctx);
    expect(await callCount(ctx)).toBe(1);
    await mcp.catalog(ctx);
    expect(await callCount(ctx)).toBe(1);
    const next = { ...query, name: 'next' };
    await writeFile(catalogPath, JSON.stringify([query, next, control]));
    expect(await mcp.probe(ctx.toolConnections[0], ctx.getSecret)).toContain('next');
    expect(await callCount(ctx)).toBe(2);
    await writeFile(catalogPath, JSON.stringify([query, control]));
    await mcp.call('catalog', 'control', { action: 'notify' }, ctx);
    expect(await mcp.catalog(ctx)).toHaveLength(2);
    expect(await callCount(ctx)).toBe(3);
    const alternative = path.join(directory, 'alternative.json');
    await writeFile(alternative, JSON.stringify([next, control]));
    ctx.toolConnections[0].args = [script, alternative];
    expect((await mcp.catalog(ctx)).map(item => item.name)).toContain(remoteToolAlias(ctx.toolConnections[0], 'next'));
    await expect(mcp.call('catalog', 'control', { action: 'disconnect' }, ctx)).rejects.toThrow();
    expect(await mcp.catalog(ctx)).toHaveLength(2);
  });

  it('keeps aliases unique and bounded, isolates unavailable connections and passes cancellation', async () => {
    const first = connection('目录.one');
    const second = connection('目录_one');
    const unavailable = { ...connection('unavailable'), command: path.join(directory, 'missing-command') };
    const ctx = context([first, second, unavailable]);
    const tools = await mcp.catalog(ctx);
    expect(tools).toHaveLength(6);
    expect(new Set(tools.map(item => item.name)).size).toBe(6);
    const long = remoteToolAlias(first, 'a'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(remoteToolAlias(first, 'a.b')).not.toBe(remoteToolAlias(first, 'a_b'));
    expect(mcp.diagnostics(ctx)).toEqual([{ connectionId: 'unavailable', message: 'MCP 工具目录获取失败，请检测连接' }]);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const pending = mcp.call(first.id, 'control', { action: 'delay' }, ctx);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });
});
