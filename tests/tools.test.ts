import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { ToolExecutionContext } from '../src/domain/tools.js';
import type { Artifact } from '../src/domain/types.js';
import { createToolRegistry } from '../src/tools/index.js';

function context(directory: string): ToolExecutionContext {
  const artifacts: Artifact[] = [];
  const observations = new Map<string, string>();
  return {
    runId: 'run',
    task: {
      id: 'task',
      conversationId: 'conversation',
      botId: 'bot',
      dependencyIds: [],
      goal: 'test',
      expectedOutput: 'document',
      status: 'running',
      runIds: ['run'],
      artifactIds: [],
      requestId: 'request',
      depth: 0,
      createdAt: '',
      updatedAt: '',
    },
    botId: 'bot',
    conversation: {
      id: 'conversation',
      name: 'Test',
      kind: 'group',
      memberIds: ['bot'],
      workspaceId: 'workspace',
      createdAt: '',
    },
    workspace: { id: 'workspace', name: 'Test', path: directory, writable: true },
    signal: new AbortController().signal,
    requestApproval: async () => false,
    listArtifacts: () => artifacts,
    observeFile: (path, version) => observations.set(path, version),
    getObservedFileVersion: (path) => observations.get(path),
    ownsFile: (path, version) =>
      artifacts.some(
        (item) => item.path === path && item.sha256 === version && item.taskId === 'task',
      ),
    registerArtifact: (input) => {
      const artifact = {
        ...input,
        id: `artifact-${artifacts.length}`,
        createdAt: new Date().toISOString(),
      };
      artifacts.push(artifact);
      return artifact;
    },
    findArtifact: (id) => artifacts.find((item) => item.id === id),
    postMessage: () => 'message',
    readMessages: () => [],
    delegateTask: () => {
      throw new Error('unused');
    },
    getTask: () => undefined,
    recallMemory: () => [],
    proposeMemory: () => {
      throw new Error('unused');
    },
    getSecret: async () => undefined,
    toolConnections: [],
    skills: [],
  };
}

describe('workspace tools', () => {
  let directory: string, outside: string;
  let registry = createToolRegistry();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ai-team-tools-'));
    outside = await mkdtemp(path.join(tmpdir(), 'ai-team-outside-'));
    registry = createToolRegistry();
  });
  afterEach(async () => {
    await registry.close();
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('rejects traversal and symlink escapes for reads and new outputs', async () => {
    const ctx = context(directory);
    await writeFile(path.join(outside, 'private.txt'), 'private');
    await symlink(outside, path.join(directory, 'escape'));
    await expect(registry.execute('read_file', { path: '../private.txt' }, ctx)).rejects.toThrow(
      '授权',
    );
    await expect(
      registry.execute('read_file', { path: 'escape/private.txt' }, ctx),
    ).rejects.toThrow('符号链接');
    await expect(
      registry.execute(
        'write_artifact',
        { path: 'escape/new.md', format: 'markdown', content: 'x' },
        ctx,
      ),
    ).rejects.toThrow('符号链接');
  });

  it('registers hashed real artifacts and updates only current task artifacts without approval', async () => {
    const ctx = context(directory);
    const artifact = (await registry.execute(
      'write_artifact',
      { path: 'output/report.md', format: 'markdown', title: '报告', content: '真实内容' },
      ctx,
    )) as Artifact;
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.purpose).toBe('deliverable');
    expect(await readFile(artifact.path, 'utf8')).toContain('真实内容');
    await registry.execute(
      'write_artifact',
      { path: 'output/report.md', format: 'markdown', content: '更新' },
      ctx,
    );
    expect(await readFile(artifact.path, 'utf8')).toBe('更新');
    await writeFile(path.join(directory, 'original.md'), '原件');
    await registry.execute('read_file', { path: 'original.md' }, ctx);
    await expect(
      registry.execute(
        'write_artifact',
        { path: 'original.md', format: 'markdown', content: '覆盖' },
        ctx,
      ),
    ).rejects.toThrow('批准');
    expect(await readFile(path.join(directory, 'original.md'), 'utf8')).toBe('原件');
    await expect(registry.execute('delete_file', { path: 'original.md' }, ctx)).rejects.toThrow(
      '批准',
    );
    await expect(
      registry.execute(
        'run_command',
        { command: process.execPath, args: ['-e', 'process.exit(0)'] },
        ctx,
      ),
    ).rejects.toThrow('批准');
  });

  it('records explicit artifact purpose without treating JSON as a process format', async () => {
    const ctx = context(directory);
    await writeFile(path.join(directory, 'final.json'), '{"result":1}');
    const final = (await registry.execute(
      'register_artifact',
      { path: 'final.json' },
      ctx,
    )) as Artifact;
    const intermediate = (await registry.execute(
      'register_artifact',
      { path: 'final.json', purpose: 'intermediate' },
      ctx,
    )) as Artifact;
    const draft = (await registry.execute(
      'write_artifact',
      { path: 'draft.md', format: 'markdown', content: '草稿', purpose: 'intermediate' },
      ctx,
    )) as Artifact;
    expect(final).toMatchObject({ mimeType: 'application/json', purpose: 'deliverable' });
    expect(intermediate.purpose).toBe('intermediate');
    expect(draft.purpose).toBe('intermediate');
    const listed = (await registry.execute('list_artifacts', {}, ctx)) as { items: Artifact[] };
    expect(listed.items.map((item) => item.purpose)).toEqual([
      'deliverable',
      'intermediate',
      'intermediate',
    ]);
    expect(await readFile(final.path, 'utf8')).toBe('{"result":1}');
  });

  it('creates and reads office documents with source locations', async () => {
    const ctx = context(directory);
    const docx = (await registry.execute(
      'write_artifact',
      { path: 'report.docx', format: 'docx', content: '第一段\n第二段' },
      ctx,
    )) as Artifact;
    const word = (await registry.execute('read_artifact', { artifactId: docx.id }, ctx)) as {
      content: string;
    };
    expect(JSON.parse(word.content).paragraphs[0].text).toContain('第一段');
    const xlsx = (await registry.execute(
      'write_artifact',
      {
        path: 'data.xlsx',
        format: 'xlsx',
        sheets: [
          {
            name: '数据',
            rows: [
              ['名称', '数量'],
              ['苹果', 3],
            ],
          },
        ],
      },
      ctx,
    )) as Artifact;
    const workbook = (await registry.execute('read_artifact', { artifactId: xlsx.id }, ctx)) as {
      content: string;
    };
    const sheet = JSON.parse(workbook.content).sheets[0];
    expect(sheet.name).toBe('数据');
    expect(sheet.rows[1]).toEqual({ row: 2, values: ['苹果', '3'] });
    await expect(
      registry.execute('read_artifact', { artifactId: 'another-conversation' }, ctx),
    ).rejects.toThrow('未授权');
  });

  it('checks the observed version again after artifact overwrite approval', async () => {
    const ctx = context(directory);
    const target = path.join(directory, 'original.md');
    await writeFile(target, 'original');
    await expect(
      registry.execute(
        'write_artifact',
        { path: 'original.md', format: 'markdown', content: 'changed' },
        ctx,
      ),
    ).rejects.toThrow('先读取');
    await registry.execute('read_file', { path: 'original.md' }, ctx);
    ctx.requestApproval = async () => {
      await writeFile(target, 'external');
      return true;
    };
    await expect(
      registry.execute(
        'write_artifact',
        { path: 'original.md', format: 'markdown', content: 'changed' },
        ctx,
      ),
    ).rejects.toThrow('版本');
    expect(await readFile(target, 'utf8')).toBe('external');
  });

  it('embeds readable Chinese PDF text with page attribution when a system font is available', async () => {
    try {
      await access('/System/Library/Fonts/Supplemental/Arial Unicode.ttf');
    } catch {
      return;
    }
    const ctx = context(directory);
    const artifact = (await registry.execute(
      'write_artifact',
      { path: 'report.pdf', format: 'pdf', title: '中文报告', content: '计划内容与成果交付。' },
      ctx,
    )) as Artifact;
    const output = (await registry.execute('read_artifact', { artifactId: artifact.id }, ctx)) as {
      content: string;
    };
    const page = JSON.parse(output.content).pages[0];
    expect(page.page).toBe(1);
    expect(page.text).toContain('计划内容与成果交付');
  });

  it('only exposes available capability definitions and rejects invalid parameters', async () => {
    const ctx = context(directory);
    ctx.workspace.writable = false;
    const names = registry.definitions(ctx).map((tool) => tool.name);
    expect(names).not.toContain('write_artifact');
    expect(names).not.toContain('search_web');
    expect(names).not.toContain('call_mcp');
    await expect(
      registry.execute('write_artifact', { path: 'x.md', format: 'markdown' }, ctx),
    ).rejects.toThrow('不可用');
    await expect(registry.execute('read_messages', { limit: 0 }, ctx)).rejects.toThrow();
    await expect(
      registry.execute('post_message', { content: 'text', botId: 'spoof' }, ctx),
    ).rejects.toThrow();
    await expect(
      registry.execute('fetch_web', { url: 'http://127.0.0.1/latest/meta-data' }, ctx),
    ).rejects.toThrow('元数据');
  });

  it('reuses static inputSchema across definitions calls while reflecting dynamic context permissions immediately', async () => {
    const ctx = context(directory);
    ctx.workspace.writable = false;
    const first = registry.definitions(ctx),
      second = registry.definitions(ctx);
    expect(first).not.toBe(second);
    const firstRead = first.find((tool) => tool.name === 'read_file')!,
      secondRead = second.find((tool) => tool.name === 'read_file')!;
    expect(firstRead).not.toBe(secondRead);
    expect(firstRead.inputSchema).toBe(secondRead.inputSchema);
    expect(Object.isFrozen(firstRead.inputSchema)).toBe(true);
    expect(
      first.some(
        (tool) =>
          tool.name === 'write_artifact' ||
          tool.name === 'read_skill' ||
          tool.name === 'search_web',
      ),
    ).toBe(false);
    await expect(
      registry.execute('write_artifact', { path: 'x.md', format: 'markdown', content: 'ok' }, ctx),
    ).rejects.toThrow('不可用');
    await expect(registry.execute('read_skill', { skillId: 'skill-1' }, ctx)).rejects.toThrow(
      '不可用',
    );
    await expect(registry.execute('search_web', { query: 'test' }, ctx)).rejects.toThrow('不可用');

    ctx.workspace.writable = true;
    ctx.skills = [
      {
        id: 'skill-1',
        name: 'Skill 1',
        description: 'desc',
        content: 'skill-content',
        path: directory,
      },
    ];
    ctx.toolConnections = [
      {
        id: 'search-1',
        name: 'Search',
        kind: 'search',
        enabled: true,
        url: 'https://example.com',
        toolNames: ['search_web'],
        status: 'ready',
      },
    ];
    const updatedNames = registry.definitions(ctx).map((tool) => tool.name);
    expect(updatedNames).toEqual(
      expect.arrayContaining(['write_artifact', 'read_skill', 'search_web']),
    );
    await expect(
      registry.execute('write_artifact', { path: 'x.md', format: 'markdown', content: 'ok' }, ctx),
    ).resolves.toMatchObject({ name: 'x.md' });
    await expect(
      registry.execute('read_skill', { skillId: 'skill-1' }, ctx),
    ).resolves.toMatchObject({ id: 'skill-1', content: 'skill-content' });
  });

  it('lists and calls a real MCP server and reuses durable Bridge mutation receipts', async () => {
    const require = createRequire(import.meta.url);
    const moduleUrl = (name: string) => pathToFileURL(require.resolve(name)).href;
    const script = `import {McpServer} from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/mcp.js'))};
      import {StdioServerTransport} from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
      import {z} from ${JSON.stringify(moduleUrl('zod'))};
      const server = new McpServer({name:'tools-test',version:'1.0.0'}); let count=0;
      server.registerTool('create_task',{inputSchema:{goal:z.string(),client_request_id:z.string()},annotations:{readOnlyHint:false}},async args=>({content:[{type:'text',text:JSON.stringify({task_id:'remote-'+(++count),requestId:args.client_request_id})}]}));
      server.registerTool('get_task',{inputSchema:{task_id:z.string()},annotations:{readOnlyHint:true}},async args=>({content:[{type:'text',text:JSON.stringify({task_id:args.task_id,status:'completed'})}]}));
      server.registerTool('disconnect',{inputSchema:{client_request_id:z.string()},annotations:{readOnlyHint:false}},async ()=>{process.exit(0)});
      await server.connect(new StdioServerTransport());`;
    const serverPath = path.join(directory, 'server.mjs');
    await writeFile(serverPath, script);
    const ctx = context(directory);
    ctx.requestApproval = async () => true;
    ctx.toolConnections.push({
      id: 'bridge',
      name: 'Bridge',
      kind: 'bridge',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      toolNames: [],
      status: 'untested',
    });
    const tools = await registry.probeConnection(ctx.toolConnections[0], ctx.getSecret);
    expect(tools).toEqual(['create_task', 'get_task', 'disconnect']);
    const request = {
      connectionId: 'bridge',
      toolName: 'create_task',
      arguments: { goal: 'work' },
    };
    const initial = (await registry.execute('call_mcp', request, ctx)) as {
      remoteTaskIds: string[];
      clientRequestId: string;
    };
    expect(initial.remoteTaskIds).toEqual(['remote-1']);
    await registry.close();
    registry = createToolRegistry();
    const recovered = (await registry.execute('call_mcp', request, ctx)) as {
      reused: boolean;
      clientRequestId: string;
    };
    expect(recovered.reused).toBe(true);
    expect(recovered.clientRequestId).toBe(initial.clientRequestId);
    const queried = await registry.execute(
      'call_mcp',
      { connectionId: 'bridge', toolName: 'get_task', arguments: { task_id: 'remote-1' } },
      ctx,
    );
    expect(JSON.stringify(queried)).toContain('completed');
    await expect(
      registry.execute(
        'call_mcp',
        { connectionId: 'bridge', toolName: 'get_task', arguments: {} },
        ctx,
      ),
    ).rejects.toThrow('参数无效');
    const uncertain = { connectionId: 'bridge', toolName: 'disconnect', arguments: {} };
    await expect(registry.execute('call_mcp', uncertain, ctx)).rejects.toThrow();
    await registry.close();
    registry = createToolRegistry();
    await expect(registry.execute('call_mcp', uncertain, ctx)).rejects.toThrow('禁止重复提交');
  });
});
