import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ProviderAdapter, RunContext } from '../src/domain/provider.js';
import type { Artifact, Connection, ProcessRecord, Run, Task, Workspace } from '../src/domain/types.js';
import { CoreService } from '../src/core/service.js';
import { qoderServiceNames } from '../src/domain/qoder-services.js';

const resources: { core: CoreService; root: string }[] = [];
afterEach(async () => {
  for (const { core, root } of resources.splice(0)) {
    await core.close(); await rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture(run: ProviderAdapter['run'] = async () => { throw new Error('unused'); }) {
  const root = await mkdtemp(join(tmpdir(), 'qoder-core-services-'));
  const capabilities = { runtimeKind: 'native-agent' as const, contextOwner: 'native' as const,
    tools: 'supported' as const, resume: 'supported' as const, imageInput: 'supported' as const,
    compaction: 'supported' as const, contextUsage: 'unverified' as const, permissionEnforcement: 'mixed' as const };
  const core = new CoreService(join(root, 'state'), undefined, undefined,
    [{ kind: 'qoder', probe: async () => ({ capabilities, models: [] }), run }]);
  resources.push({ core, root });
  const connection: Connection = { id: 'qoder', name: 'Qoder fixture', provider: 'qoder', authMode: 'local',
    executable: process.execPath, profilePath: join(root, 'profile'), concurrency: 1, status: 'ready',
    models: [{ id: 'test', name: 'Test' }], capabilities, revision: 1, createdAt: '' };
  core.state.storage.put('connections', connection);
  const bot = core.entities.saveBot({ name: '成员', role: '助手', instructions: '', connectionId: connection.id,
    model: 'test', toolNames: [], approvalMode: 'auto', memoryMode: 'off', qoderServices: [...qoderServiceNames] });
  const workspace = core.state.storage.all<Workspace>('workspaces')[0];
  const room = core.entities.createConversation({ name: '测试', kind: 'private', memberIds: [bot.id], workspaceId: workspace.id });
  const task = core.tasks.create({ conversationId: room.id, botId: bot.id, goal: '原生服务测试' });
  const controller = new AbortController();
  const manualRun: Run = { id: 'run', taskId: task.id, botId: bot.id, bindingId: 'binding',
    status: 'running', configRevision: bot.revision, createdAt: '' };
  core.state.storage.put('runs', manualRun);
  core.state.storage.put('tasks', { ...task, status: 'running', runIds: [manualRun.id] });
  const context = core.tools.context(manualRun, task, bot, room, workspace, controller.signal);
  const native = core.tools.nativeTools(context, bot);
  const operation = (callId: string) => core.state.storage.get<{ status: string; result?: unknown }>('tool_operations', `run:${callId}`);
  return { core, root, bot, connection, task, workspace, context, native, controller, operation };
}

async function scanFixture(f: Awaited<ReturnType<typeof fixture>>, wait = false) {
  const script = join(f.root, 'scan-cli.cjs');
  await mkdir(join(f.connection.profilePath!, '.qoder-cn', '.auth'), { recursive: true });
  vi.stubEnv('QODERCN_CONFIG_DIR', join(f.root, 'native-auth'));
  await writeFile(script, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== '--cwd' || args[2] !== 'security' || args[3] !== 'scan') process.exit(7);
const reportIndex = args.indexOf('--report');
const files = args.slice(4, reportIndex);
for (const file of files) if (!fs.statSync(file).isFile()) process.exit(8);
const report = args[reportIndex + 1].slice(5);
console.log('fixture scanner started');
${wait ? "setInterval(() => {}, 1000);" : "fs.writeFileSync(report, JSON.stringify({ files, findings: [{ severity: 'low', message: 'fixture finding' }] }));"}
`);
  f.connection.executable = script;
  f.core.state.storage.put('connections', f.connection);
  const service = f.core.tools.processes, original = service.runService.bind(service);
  const invoke = vi.spyOn(service, 'runService').mockImplementation((input, context, environment) => {
    expect(input.command).toBe(process.execPath);
    expect(input.args.slice(0, 5)).toEqual([script, '--cwd', f.workspace.path, 'security', 'scan']);
    expect(input.args.slice(-4)).toEqual(['--fail-on', 'none', '--wait-timeout', '2']);
    expect(environment.QODERCN_CONFIG_DIR).toBe(join(f.connection.profilePath!, '.qoder-cn'));
    return original(input, context, environment);
  });
  return invoke;
}

async function waitFor(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error('未观察到进程状态');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('Qoder Core 原生服务', () => {
  it('按 Storage 当前权限执行并记录服务调用，撤权后拒绝新调用', async () => {
    const f = await fixture();
    expect(await f.native.authorize('WebSearch', { query: '资料' }, 'search')).toEqual({ query: '资料' });
    expect(f.operation('search')?.status).toBe('dispatched');
    expect(await f.native.complete('WebSearch', {}, 'search', { results: [{ title: '资料', url: 'https://example.com' }] }))
      .toEqual({ results: [{ title: '资料', url: 'https://example.com' }] });
    expect(f.operation('search')?.status).toBe('succeeded');
    expect(f.core.state.storage.events().filter(event => event.runId === 'run').map(event => event.data))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'WebSearch', status: 'running', source: 'native', service: 'Qoder' }),
        expect.objectContaining({ name: 'WebSearch', status: 'completed', source: 'native', service: 'Qoder' }),
      ]));
    f.core.state.storage.put('bots', { ...f.bot, qoderServices: [] });
    await expect(f.native.authorize('WebSearch', { query: '再搜索' }, 'revoked')).rejects.toThrow('未授权');
    expect(f.operation('revoked')).toBeUndefined();
  });

  it('已完成的调用 ID 不重新执行，也不能换参数复用', async () => {
    const f = await fixture();
    await f.native.authorize('ImageSearch', { query: '海报', count: 2 }, 'search');
    await f.native.complete('ImageSearch', {}, 'search', { images: [] });
    await expect(f.native.authorize('ImageSearch', { query: '海报', count: 2 }, 'search')).rejects.toThrow('已有执行记录');
    await expect(f.native.authorize('ImageSearch', { query: '新海报' }, 'search')).rejects.toThrow('参数不匹配');
    expect(f.core.state.storage.all('tool_operations')).toHaveLength(1);
  });

  it('生成图片复制到 App 成果目录，保留实际成员、任务、来源与最终产物标记', async () => {
    const f = await fixture(), directory = join(f.workspace.path, 'vibe_images');
    await mkdir(directory);
    const path = join(directory, 'hero.png');
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#3399ff' } }).png().toBuffer();
    await f.native.authorize('ImageGen', { name: 'hero', prompt: 'blue picture' }, 'image');
    await writeFile(path, bytes);
    const result = await f.native.complete('ImageGen', {}, 'image', { filePath: path, requestId: 'fixture-request' }) as { artifactId: string };
    const artifact = f.core.state.storage.get<Artifact>('artifacts', result.artifactId)!;
    expect(artifact).toMatchObject({ taskId: f.task.id, botId: f.bot.id, conversationId: f.context.conversation.id,
      mimeType: 'image/png', source: 'qoder-image', purpose: 'deliverable', workingPath: await realpath(path) });
    expect(artifact.path).not.toBe(path);
    await rm(path);
    expect(await readFile(artifact.path)).toEqual(bytes);
    expect(f.core.state.storage.get<Task>('tasks', f.task.id)?.artifactIds).toContain(artifact.id);
    expect(f.operation('image')?.status).toBe('succeeded');
  });

  it('只读工作区允许搜索，图片生成在派发前被拒绝', async () => {
    const f = await fixture();
    f.context.workspace.writable = false;
    f.core.state.storage.put('workspaces', { ...f.workspace, writable: false });
    await f.native.authorize('ImageSearch', { query: '配图' }, 'search');
    await f.native.complete('ImageSearch', {}, 'search', { images: [] });
    await expect(f.native.authorize('ImageGen', { name: 'hero', prompt: 'picture' }, 'image')).rejects.toThrow('可写');
    expect(f.operation('image')).toBeUndefined();
  });

  it('停止已派发的生成调用后保留结果未知与对账标记，不注册假成果', async () => {
    const f = await fixture();
    await f.native.authorize('ImageGen', { name: 'hero', prompt: 'picture' }, 'image');
    f.controller.abort(new Error('用户停止'));
    expect(f.operation('image')?.status).toBe('unknown');
    expect(f.core.state.storage.get<Task>('tasks', f.task.id)).toMatchObject({ reconciliationRequired: true, status: 'running' });
    expect(f.core.state.storage.all('artifacts')).toHaveLength(0);
    await expect(f.native.complete('ImageGen', {}, 'image', { filePath: 'vibe_images/hero.png' })).rejects.toThrow('已授权调用');
  });

  it('模型报告完成但生成服务未确认时，Executor 保留失败与对账状态', async () => {
    const f = await fixture(async (context: RunContext) => {
      await context.nativeTools!.authorize('ImageGen', { name: 'hero', prompt: 'picture' }, 'unfinished');
      return { text: '已完成' };
    });
    f.core.tools.releaseRun('run');
    await f.core.executor.execute(f.task, f.controller.signal);
    expect(f.core.state.storage.get<Task>('tasks', f.task.id)).toMatchObject({ status: 'failed', reconciliationRequired: true });
    expect(f.core.state.storage.all<{ status: string }>('tool_operations')).toEqual([expect.objectContaining({ status: 'unknown' })]);
    expect(f.core.state.storage.all('artifacts')).toHaveLength(0);
  });
});

describe('Qoder 安全扫描', () => {
  it('只扫描授权范围的普通文件，在只读工作区运行真实任务进程并持久保留报告', async () => {
    const f = await fixture();
    f.context.workspace.writable = false;
    f.core.state.storage.put('workspaces', { ...f.workspace, writable: false });
    await mkdir(join(f.workspace.path, 'src'));
    await writeFile(join(f.workspace.path, 'src', 'main.ts'), 'export const number = 1;');
    await writeFile(join(f.workspace.path, 'src', '.env'), 'TEST_ONLY=fixture');
    const invoke = await scanFixture(f);
    const tools = f.core.tools.definitions(f.context, f.bot).map(tool => tool.name);
    expect(tools).toContain('scan_code_security');
    expect(tools).not.toContain('run_command');
    const result = await f.context.scanCodeSecurity!({ paths: ['src'], timeoutMs: 2000 }) as { artifactId: string; scannedFiles: number };
    expect(result.scannedFiles).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    const record = f.core.state.storage.all<ProcessRecord>('processes')[0];
    expect(record).toMatchObject({ taskId: f.task.id, botId: f.bot.id, runId: 'run', status: 'completed', code: 0 });
    expect(record.pid).toBeGreaterThan(0);
    expect(f.core.tools.processes.hasActive()).toBe(false);
    const artifact = f.core.state.storage.get<Artifact>('artifacts', result.artifactId)!;
    expect(artifact).toMatchObject({ taskId: f.task.id, botId: f.bot.id, source: 'qoder-security-scan', purpose: 'deliverable' });
    expect(JSON.parse(await readFile(artifact.path, 'utf8'))).toMatchObject({ files: [await realpath(join(f.workspace.path, 'src', 'main.ts'))] });
    const report = record.args[record.args.indexOf('--report') + 1].slice(5);
    await expect(access(report)).rejects.toThrow();
    expect(await readFile(artifact.path, 'utf8')).toContain('fixture finding');
  });

  it('拒绝工作区外与凭据路径，审批期间撤权后不创建扫描进程', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'outside.ts'), 'export const value = 1;');
    await writeFile(join(f.workspace.path, 'main.ts'), 'export const value = 1;');
    await expect(f.context.scanCodeSecurity!({ paths: [join(f.root, 'outside.ts')] })).rejects.toThrow('授权');
    await expect(f.context.scanCodeSecurity!({ paths: ['.env'] })).rejects.toThrow('凭据');
    f.context.requestApproval = async () => {
      f.core.state.storage.put('bots', { ...f.bot, qoderServices: [] });
      return true;
    };
    await expect(f.context.scanCodeSecurity!({ paths: ['main.ts'] })).rejects.toThrow('授权已改变');
    expect(f.core.state.storage.all('processes')).toHaveLength(0);
    expect(f.core.state.storage.all('artifacts')).toHaveLength(0);
  });

  it('取消扫描等待实际进程退出，保留停止状态且不发布报告', async () => {
    const f = await fixture();
    await writeFile(join(f.workspace.path, 'main.ts'), 'export const value = 1;');
    await scanFixture(f, true);
    const pending = f.context.scanCodeSecurity!({ paths: ['main.ts'], timeoutMs: 2000 });
    const rejected = expect(pending).rejects.toThrow('用户停止');
    await waitFor(() => f.core.tools.processes.hasActiveRun('run'));
    f.controller.abort(new Error('用户停止'));
    await rejected;
    expect(f.core.tools.processes.hasActive()).toBe(false);
    expect(f.core.state.storage.all<ProcessRecord>('processes')[0]).toMatchObject({ status: 'stopped', taskId: f.task.id });
    expect(f.core.state.storage.all('artifacts')).toHaveLength(0);
  });
});
