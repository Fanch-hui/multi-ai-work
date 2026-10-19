import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import type { ToolConnection } from '../src/domain/types.js';
import { McpConnections } from '../src/tools/mcp.js';
import { remoteToolAlias } from '../src/tools/mcp-catalog.js';

describe('MCP session lifecycle', () => {
  let directory: string;
  let script: string;
  let startedPath: string;
  let closedPath: string;
  let gatePath: string;
  let mcp: McpConnections;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ai-team-mcp-lifecycle-'));
    script = path.join(directory, 'server.mjs');
    startedPath = path.join(directory, 'started');
    closedPath = path.join(directory, 'closed');
    gatePath = path.join(directory, 'ready');
    mcp = new McpConnections();
    const require = createRequire(import.meta.url);
    const moduleUrl = (name: string) => pathToFileURL(require.resolve(name)).href;
    await writeFile(
      script,
      `
      import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
      import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
      import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
      import { appendFileSync, existsSync } from 'node:fs';
      const [started, closed, gate, name] = process.argv.slice(2);
      appendFileSync(started, process.pid + '\\n');
      process.on('exit', () => appendFileSync(closed, process.pid + '\\n'));
      process.on('SIGTERM', () => process.exit(0));
      const server = new Server({ name: 'lifecycle-test', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 5));
        return { tools: [{ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
      });
      server.setRequestHandler(CallToolRequestSchema, async request => {
        if (request.params.arguments?.disconnect) process.exit(0);
        return { content: [{ type: 'text', text: String(process.pid) }] };
      });
      await server.connect(new StdioServerTransport());
    `,
    );
    await writeFile(gatePath, 'ready');
  });

  afterEach(async () => {
    await writeFile(gatePath, 'ready');
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  });

  function connection(id = 'shared', name = 'query'): ToolConnection {
    return {
      id,
      name: 'Test',
      kind: 'mcp',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [script, startedPath, closedPath, gatePath, name],
      toolNames: [],
      status: 'ready',
    };
  }

  function context(connections = [connection()]): ToolExecutionContext {
    return {
      toolConnections: connections,
      getSecret: async () => undefined,
      signal: new AbortController().signal,
      requestApproval: async () => true,
    } as unknown as ToolExecutionContext;
  }

  async function pids(file: string): Promise<number[]> {
    try {
      return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(Number);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async function waitForCount(file: string, count: number): Promise<void> {
    await expect.poll(async () => (await pids(file)).length).toBe(count);
  }

  it('shares one process for concurrent initial connections and closed-session reconnects', async () => {
    const ctx = context();
    const descriptions = await Promise.all(
      Array.from({ length: 8 }, () => mcp.describe('shared', ctx)),
    );
    expect(descriptions.every((tools) => Array.isArray(tools) && tools.length === 1)).toBe(true);
    expect(await pids(startedPath)).toHaveLength(1);
    await expect(mcp.call('shared', 'query', { disconnect: true }, ctx)).rejects.toThrow();
    await waitForCount(closedPath, 1);
    await Promise.all(Array.from({ length: 8 }, () => mcp.describe('shared', ctx)));
    expect(await pids(startedPath)).toHaveLength(2);
    await mcp.remove('shared');
    await waitForCount(closedPath, 2);
  });

  it('serializes configuration replacements and releases each superseded process', async () => {
    const first = context([connection('shared', 'first')]);
    const second = context([connection('shared', 'second')]);
    const third = context([connection('shared', 'third')]);
    await mcp.describe('shared', first);
    const [secondTools, thirdTools] = await Promise.all([
      mcp.describe('shared', second),
      mcp.describe('shared', third),
    ]);
    expect(secondTools).toEqual([expect.objectContaining({ name: 'second' })]);
    expect(thirdTools).toEqual([expect.objectContaining({ name: 'third' })]);
    expect(await pids(startedPath)).toHaveLength(3);
    await waitForCount(closedPath, 2);
    await mcp.remove('shared');
    await waitForCount(closedPath, 3);
  });

  it('removes aliases and diagnostics and permits a fresh connection after removal', async () => {
    const ctx = context();
    await mcp.catalog(ctx);
    const alias = remoteToolAlias(ctx.toolConnections[0], 'query');
    expect(mcp.resolve(alias, ctx)).toBeDefined();
    await mcp.remove('shared');
    expect(mcp.resolve(alias, ctx)).toBeUndefined();
    await waitForCount(closedPath, 1);
    const unavailable = context([
      { ...connection('unavailable'), command: path.join(directory, 'missing') },
    ]);
    expect(await mcp.catalog(unavailable)).toEqual([]);
    expect(mcp.diagnostics(unavailable)).toHaveLength(1);
    await mcp.remove('unavailable');
    expect(mcp.diagnostics(unavailable)).toEqual([]);
    expect(await mcp.describe('shared', ctx)).toHaveLength(1);
    expect(await pids(startedPath)).toHaveLength(2);
  });

  it('recovers after a failed connection without blocking another connection ID', async () => {
    const broken = context([{ ...connection(), command: path.join(directory, 'missing') }]);
    await expect(mcp.describe('shared', broken)).rejects.toThrow();
    const ctx = context();
    expect(await mcp.describe('shared', ctx)).toHaveLength(1);
    await rm(gatePath);
    const blocked = mcp.describe('waiting', context([connection('waiting')]));
    await waitForCount(startedPath, 2);
    expect(await mcp.describe('shared', ctx)).toHaveLength(1);
    await writeFile(gatePath, 'ready');
    await blocked;
  });

  it('waits for an initializing session when removing it and clears its catalog', async () => {
    await rm(gatePath);
    const ctx = context();
    const catalog = mcp.catalog(ctx);
    await waitForCount(startedPath, 1);
    const removed = mcp.remove('shared');
    await writeFile(gatePath, 'ready');
    await Promise.all([catalog, removed]);
    expect(mcp.resolve(remoteToolAlias(ctx.toolConnections[0], 'query'), ctx)).toBeUndefined();
    expect(mcp.diagnostics(ctx)).toEqual([]);
    await waitForCount(closedPath, 1);
  });

  it('closes cached and initializing sessions and rejects new connections during shutdown', async () => {
    await mcp.describe('cached', context([connection('cached')]));
    await rm(gatePath);
    const connecting = mcp.describe('starting', context([connection('starting')]));
    await waitForCount(startedPath, 2);
    const closing = mcp.close();
    expect(mcp.close()).toBe(closing);
    await expect(mcp.describe('late', context([connection('late')]))).rejects.toThrow('已关闭');
    await writeFile(gatePath, 'ready');
    await Promise.all([connecting, closing]);
    await waitForCount(closedPath, 2);
    expect(await pids(startedPath)).toHaveLength(2);
  });
});
