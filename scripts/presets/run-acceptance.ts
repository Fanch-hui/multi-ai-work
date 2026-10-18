import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { CoreService } from '../../src/core/service.js';
import { startHttp } from '../../src/core/http.js';
import { terminal } from '../../src/core/tasks.js';
import { publicError } from '../../src/core/errors.js';
import { catalogSchema } from '../../src/core/market/schema.js';
import type { AgentPreset, PresetMemberResult } from '../../src/domain/market.js';
import type { Bot, Connection, Task } from '../../src/domain/types.js';
import { digest, fixtureSchema, json, presetDigest, saveEvidence, saveWorkspace, stageFixture, type Fixture } from './acceptance-evidence.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `职业预设真实运行验收
用法：pnpm exec tsx scripts/presets/run-acceptance.ts --fixtures <JSON> [选项]
默认校验目录、ZIP 和逐岗位模拟资料；不探测登录、不调用模型。
  --run                   执行真实推理，保存待人工审阅的证据
  --provider <id>          qoder（默认）或 antigravity，复用官方本机登录
  --compute               授权本批岗位在临时工作目录使用随包运行库和命令计算
  --preset <id>           选择岗位，可重复；省略则选择全部目录
  --catalog <路径>        默认 resources/agent-presets/catalog.json
  --packages <目录>       默认 release/presets，先用 build.py 生成 ZIP
  --output <目录>         默认 release/preset-acceptance/run-<时间>
  --model <id>            默认 qmodel_38max
  --concurrency 1~4       默认 2
  --timeout-ms <毫秒>     每岗位默认 480000，最大 600000
  --skip-existing         跳过摘要匹配且已完成技能读取和可读成果的证据
fixture JSON 为 {presetId:{scenario,prompt,files:[{path,content}],reviewChecks:[]}}。
默认仅技能读取和临时目录读写；--compute 显式增加随包运行库和命令计算，不授予外部连接。
结果始终标 pending_review；完成、实际 read_skill 和可读成果只是运行事实。`;
const tools = ['read_skill', 'read_file', 'read_artifact', 'write_artifact', 'write_file',
  'list_directory', 'register_artifact', 'ask_user', 'get_task'];

async function waitForTask(core: CoreService, taskId: string, timeout: number): Promise<Task> {
  const deadline = Date.now() + timeout;
  while (true) {
    const task = core.state.storage.get<Task>('tasks', taskId)!;
    if (terminal(task.status) || task.status === 'waiting_input' || task.status === 'waiting_approval') return task;
    if (Date.now() >= deadline) {
      await core.scheduler.cancel(taskId);
      return { ...core.state.storage.get<Task>('tasks', taskId)!, error: '验收执行超时' };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
async function runPreset(core: CoreService, preset: AgentPreset, fixture: Fixture, packages: string,
  workspaceRoot: string, outputRoot: string, connection: Connection, model: string, timeout: number, compute: boolean) {
  const output = join(outputRoot, preset.id), workspacePath = join(workspaceRoot, preset.id);
  await mkdir(workspacePath, { recursive: true }); await stageFixture(workspacePath, fixture);
  const installation = await core.market.import(join(packages, `${preset.id}-${preset.version}.zip`));
  if (presetDigest(installation.preset) !== presetDigest(preset)) throw new Error('ZIP 预设与当前目录摘要不一致');
  const result = await core.request('market.members.create', { items: [{ requestId: `acceptance:${preset.id}`,
    installationId: installation.id, configuration: { connectionId: connection.id, model, toolNames: compute ? [...tools, 'load_workspace_dependencies', 'run_command'] : tools,
      toolConnectionIds: [], approvalMode: 'auto' } }] }) as PresetMemberResult[];
  if (!result[0]?.botId) throw new Error(result[0]?.error ?? '预设成员未创建');
  const bot = core.state.storage.get<Bot>('bots', result[0].botId)!;
  core.state.storage.put('bots', { ...bot, memoryMode: 'off' });
  const workspace = await core.entities.addWorkspace({ name: preset.name, path: workspacePath, writable: true });
  const conversation = core.entities.createConversation({ name: preset.name, kind: 'private',
    memberIds: [bot.id], workspaceId: workspace.id });
  const goal = `${fixture.prompt}\n\n这是模拟岗位验收。先实际读取对应技能入口，再按技能流程处理资料。`
    + `资料位于工作目录：${fixture.files.map(file => file.path).join('、') || '见以上描述'}。`
    + '生成可读 Markdown 成果并使用 write_artifact 保存。缺失资料明确标待确认，不编造事实；说明所采用的技能步骤。';
  const started = Date.now();
  const task = core.tasks.create({ conversationId: conversation.id, botId: bot.id, goal });
  const settled = await waitForTask(core, task.id, timeout);
  try {
    const report = await saveEvidence(core, preset, fixture, settled, output, model, Date.now() - started, connection.provider);
    await saveWorkspace(workspacePath, join(output, 'workspace'));
    return report;
  }
  finally { if (!terminal(settled.status)) await core.scheduler.cancel(task.id); }
}
async function prepare(args: string[]) {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean' }, run: { type: 'boolean' },
    compute: { type: 'boolean' }, fixtures: { type: 'string' }, preset: { type: 'string', multiple: true }, catalog: { type: 'string' },
    packages: { type: 'string' }, output: { type: 'string' }, model: { type: 'string', default: 'qmodel_38max' },
    provider: { type: 'string', default: 'qoder' },
    concurrency: { type: 'string', default: '2' }, 'timeout-ms': { type: 'string', default: '480000' },
    'skip-existing': { type: 'boolean' } } });
  if (values.help) { console.log(help); return; }
  if (!values.fixtures) throw new Error('--fixtures 必填');
  const provider = z.enum(['qoder', 'antigravity']).parse(values.provider);
  const concurrency = Number(values.concurrency), timeout = Number(values['timeout-ms']);
  if (![1, 2, 3, 4].includes(concurrency)) throw new Error('concurrency 必须为 1 至 4');
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error('timeout-ms 必须为 1000 至 600000');
  const catalog = catalogSchema.parse(JSON.parse(await readFile(resolve(values.catalog ?? join(root, 'resources/agent-presets/catalog.json')), 'utf8')));
  const fixtures = z.record(z.string(), fixtureSchema).parse(JSON.parse(await readFile(resolve(values.fixtures), 'utf8')));
  const ids = new Set(values.preset ?? catalog.presets.map(preset => preset.id));
  for (const id of ids) if (!catalog.presets.some(preset => preset.id === id)) throw new Error(`目录中不存在 ${id}`);
  const presets = catalog.presets.filter(preset => ids.has(preset.id));
  if (!presets.length) throw new Error('未选择任何岗位');
  const packages = resolve(values.packages ?? join(root, 'release/presets'));
  for (const preset of presets) {
    if (!fixtures[preset.id]) throw new Error(`缺少岗位模拟资料：${preset.id}`);
    await readFile(join(packages, `${preset.id}-${preset.version}.zip`));
  }
  return { presets, fixtures, packages, concurrency, timeout, model: values.model!, provider, run: values.run,
    skipExisting: values['skip-existing'], compute: !!values.compute,
    output: resolve(values.output ?? join(root, 'release/preset-acceptance', `run-${Date.now()}`)) };
}
async function existingReports(input: NonNullable<Awaited<ReturnType<typeof prepare>>>) {
  if (!input.skipExisting) return {};
  try { return JSON.parse(await readFile(join(input.output, 'acceptance.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
async function canSkip(preset: AgentPreset, fixture: Fixture, model: string, provider: string, output: string, report: unknown) {
  const item = report as { presetDigest?: string; fixtureDigest?: string; scope?: { model?: string; provider?: string } } | undefined;
  if (item?.presetDigest !== presetDigest(preset) || item.fixtureDigest !== digest(fixture)
    || item.scope?.model !== model || item.scope.provider !== provider) return false;
  try {
    const run = JSON.parse(await readFile(join(output, preset.id, 'run.json'), 'utf8')) as {
      preset: AgentPreset; status: string; checks: Record<string, boolean>; toolOperations: { name: string; status: string; skillId?: string }[];
      artifacts: { name: string; readable: boolean; sha256: string }[] };
    if (presetDigest(run.preset) !== presetDigest(preset) || run.status !== 'completed'
      || !run.checks.completed || !run.checks.boundSkillRead || !run.checks.readableArtifact
      || !run.toolOperations.some(item => item.name === 'read_skill' && item.status === 'succeeded' && item.skillId)) return false;
    for (const artifact of run.artifacts.filter(item => item.readable)) {
      const bytes = await readFile(join(output, preset.id, artifact.name));
      if (bytes.length && createHash('sha256').update(bytes).digest('hex') === artifact.sha256) return true;
    }
    return false;
  } catch { return false; }
}
export async function main(args = process.argv.slice(2)) {
  const input = await prepare(args); if (!input) return;
  if (!input.run) { console.log(JSON.stringify({ prepared: input.presets.map(preset => preset.id), inferenceRequested: false })); return; }
  await mkdir(dirname(input.output), { recursive: true });
  await mkdir(input.output, { recursive: !!input.skipExisting });
  const temporary = await mkdtemp(join(tmpdir(), 'multi-ai-preset-acceptance-'));
  const core = new CoreService(join(temporary, 'core')); let server: Awaited<ReturnType<typeof startHttp>> | undefined;
  const reports: Record<string, unknown> = await existingReports(input);
  try {
    await core.start(); server = await startHttp(core, false);
    const saved = await core.entities.saveConnection({ name: '岗位验收', provider: input.provider, authMode: 'local', concurrency: input.concurrency });
    const connection = await core.request('connections.probe', { id: saved.id }) as Connection;
    if (connection.status !== 'ready') throw new Error(connection.error ?? '官方本机连接未准备完成');
    if (!connection.models.some(model => model.id === input.model)) throw new Error('所选模型不在当前连接可用目录中');
    const queue: AgentPreset[] = [];
    for (const preset of input.presets) {
      if (input.skipExisting && await canSkip(preset, input.fixtures[preset.id], input.model, input.provider, input.output, reports[preset.id]))
        console.log(`${preset.id}: existing evidence matches, review status retained`);
      else queue.push(preset);
    }
    let writing = Promise.resolve();
    const worker = async () => {
      let preset: AgentPreset | undefined;
      while ((preset = queue.shift())) {
        console.log(`${preset.id}: running`);
        try { reports[preset.id] = await runPreset(core, preset, input.fixtures[preset.id], input.packages,
          join(temporary, 'workspaces'), input.output, connection, input.model, input.timeout, input.compute); }
        catch (error) { reports[preset.id] = { version: preset.version, runtimeAcceptance: 'pending_review',
          contentReview: 'pending_review', error: publicError(error), checks: { completed: false } }; }
        writing = writing.then(() => json(join(input.output, 'acceptance.json'), reports)); await writing;
        console.log(`${preset.id}: evidence saved, pending_review`);
      }
    };
    await Promise.all(Array.from({ length: input.concurrency }, worker));
  } finally { await core.close(); await server?.close(); await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
}
