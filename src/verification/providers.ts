import { parseArgs } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Connection, ProviderKind } from '../domain/types.js';
import type { ProviderAdapter, RunContext } from '../domain/provider.js';
import { AntigravityAdapter, QoderAdapter } from '../providers/native/index.js';
import { ChatGptAdapter, CustomApiAdapter } from '../providers/managed/index.js';
import { detectNativeSetup } from '../providers/native/setup.js';
import { verificationTools } from './tool-channel.js';

type Check = { status: 'passed' | 'failed' | 'unverified'; detail: string };
type Report = { provider: ProviderKind; node: string; platform: string; architecture: string; version?: string;
  capabilities?: unknown; modelCount?: number; checks: Record<string, Check>; inferenceRequested: boolean };
const help = `multi-AI work 通道验证
用法：pnpm verify:providers --provider antigravity|qoder|chatgpt|custom [选项]
默认只显示运行时准备情况，不探测账号、不执行模型推理。
  --help                  显示帮助
  --probe                 仅握手、登录状态与模型目录探测
  --run --model <id>      明确授权真实推理：两轮、只读工具、会话恢复与取消（可能计费）
  --executable <绝对路径> 原生 agy / Qoder CLI
  --profile <绝对路径>    App 会话归属目录；agy / Qoder 复用本机官方授权
  --base-url <https URL>  自定义 API 地址（localhost 允许 HTTP）
  --protocol <协议>       chat-completions（默认）或 responses
  --token-env <变量名>    凭据环境变量名，绝不通过命令参数传入凭据
  --auth-none             自定义本地 API 无认证
  --timeout-ms <毫秒>     单步骤超时，默认 120000
  --report <路径>         保存脱敏 JSON 结果
默认凭据变量：AI_TEAM_API_KEY、AI_TEAM_QODER_PAT、AI_TEAM_CHATGPT_OAUTH_JSON。
ChatGPT 需要完整的已授权 OAuth token record JSON（包含 client_id/subject/issuer/
ext_agent_host_id/access_token/id_token/token_type/scopes/expires_at），不能使用 API Key。
请在桌面先完成 ChatGPT 授权；工具不会读取桌面 vault 或直接读取 CLI 凭据；agy 原生进程通过系统 Keyring 复用官方授权。
所有推理均在临时只读验证工作目录内进行，不输出模型回答或凭据。`;
const factory = (provider: ProviderKind): ProviderAdapter => ({ antigravity: () => new AntigravityAdapter(), qoder: () => new QoderAdapter(),
  chatgpt: () => new ChatGptAdapter(), custom: () => new CustomApiAdapter() })[provider]();
const passed = (detail: string): Check => ({ status: 'passed', detail });
const unverified = (detail: string): Check => ({ status: 'unverified', detail });
const failed = (detail: string): Check => ({ status: 'failed', detail });

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' }, provider: { type: 'string' }, probe: { type: 'boolean' }, run: { type: 'boolean' },
    model: { type: 'string' }, executable: { type: 'string' }, profile: { type: 'string' }, 'base-url': { type: 'string' },
    protocol: { type: 'string', default: 'chat-completions' }, 'token-env': { type: 'string' }, 'auth-none': { type: 'boolean' },
    'timeout-ms': { type: 'string', default: '120000' }, report: { type: 'string' },
  } });
  if (values.help) { console.log(help); return 0; }
  if (!values.provider || !['antigravity', 'qoder', 'chatgpt', 'custom'].includes(values.provider)) throw new Error('请选择有效 provider；使用 --help 查看用法');
  if (!['chat-completions', 'responses'].includes(values.protocol!)) throw new Error('协议无效');
  if (values.run && !values.model) throw new Error('--run 必须明确选择 --model');
  const timeout = Number(values['timeout-ms']);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) throw new Error('超时必须为 1000 至 600000 毫秒');
  const provider = values.provider as ProviderKind;
  const appDirectory = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'multi-AI work')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? homedir(), 'multi-AI work') : join(homedir(), '.local', 'share', 'multi-AI work');
  const connection: Connection = { id: randomUUID(), name: 'verification', provider, concurrency: 1, status: 'untested', models: [], revision: 1,
    createdAt: new Date().toISOString(), baseUrl: values['base-url'],
    protocol: values.protocol as Connection['protocol'], executable: values.executable, profilePath: values.profile ?? join(appDirectory, 'runtime', provider),
    secretRef: 'verification-secret', authMode: provider === 'chatgpt' ? 'oauth' : provider === 'custom' ? values['auth-none'] ? 'none' : 'api-key' : 'local' };
  if (provider === 'antigravity' || provider === 'qoder') {
    const setup = await detectNativeSetup({ provider, executable: connection.executable, profilePath: connection.profilePath!, appRuntimeDirectory: join(appDirectory, 'cli') });
    connection.executable = setup.executable;
    if (!values.run && !values.probe) { console.log(JSON.stringify(setup, null, 2)); return 0; }
    if (!connection.executable) throw new Error('原生运行时缺失；先运行无 --probe/--run 的命令获取安装指引');
  } else if (!values.run && !values.probe) { console.log('尚未执行探测；使用 --probe 探测，或 --run --model <id> 执行真实验收。'); return 0; }
  const tokenEnv = values['token-env'] ?? ({ chatgpt: 'AI_TEAM_CHATGPT_OAUTH_JSON', custom: 'AI_TEAM_API_KEY', qoder: 'AI_TEAM_QODER_PAT', antigravity: '' })[provider];
  let secret = tokenEnv ? process.env[tokenEnv] : undefined;
  if (provider === 'qoder' && secret) connection.authMode = 'pat';
  const report: Report = { provider, node: process.versions.node, platform: process.platform, architecture: process.arch, inferenceRequested: !!values.run,
    checks: Object.fromEntries(['probe', 'text', 'multiTurn', 'tool', 'resume', 'cancel'].map(key => [key, unverified('尚未执行')])) };
  const getSecret = async () => secret;
  const saveSecret = async (_ref: string, value: string) => { secret = value; };
  const adapter = factory(provider);
  try {
    const probe = await adapter.probe({ connection, signal: AbortSignal.timeout(timeout), getSecret, saveSecret });
    Object.assign(report, { version: probe.version, capabilities: probe.capabilities, modelCount: probe.models.length });
    connection.accountScope = probe.accountScope; connection.models = probe.models;
    report.checks.probe = passed('握手与模型目录读取完成；此项不证明推理可用');
    if (values.run) await runChecks(connection, values.model!, adapter, report, timeout, getSecret, saveSecret);
  } catch { report.checks.probe = failed('探测失败；请核对授权、运行时与服务配置'); }
  finally { await adapter.close?.(); }
  if (values.report) await writeFile(resolve(values.report), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  return Object.values(report.checks).some(check => check.status === 'failed') ? 1 : 0;
}

async function runChecks(connection: Connection, model: string, adapter: ProviderAdapter, report: Report, timeout: number,
  getSecret: RunContext['getSecret'], saveSecret: RunContext['saveSecret']) {
  const folder = await mkdtemp(join(tmpdir(), 'ai-team-provider-verification-'));
  const workspacePath = join(folder, 'workspace'); await mkdir(workspacePath);
  const memoryMarker = `memory_${randomUUID().replaceAll('-', '')}`, toolMarker = `tool_${randomUUID().replaceAll('-', '')}`;
  await writeFile(join(workspacePath, 'verification.txt'), toolMarker, { mode: 0o600 });
  const channel = verificationTools(workspacePath, AbortSignal.timeout(timeout * 3));
  const context: RunContext = {
    runId: randomUUID(), connection, workspacePath, prompt: '', messages: [], instructions: '仅执行本次验证。仅获准读取 verification.txt，不调用其他工具。',
    bot: { id: 'verification', name: 'verification', role: 'verification', instructions: '', connectionId: connection.id, model, color: '#666',
      toolNames: ['read_file'], skillIds: [], memoryMode: 'off', revision: 1, archived: false },
    binding: { id: randomUUID(), botId: 'verification', connectionId: connection.id, conversationId: 'verification', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'verification', lastDeliveredSequence: 0, accountScope: connection.accountScope },
    signal: AbortSignal.timeout(timeout), tools: channel.tools, getSecret, saveSecret,
    nativeMcp: { command: process.execPath,
      args: import.meta.url.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
        fileURLToPath(new URL('./mcp-worker.ts', import.meta.url))] : [fileURLToPath(new URL('./mcp-worker.js', import.meta.url))],
      env: { AI_TEAM_VERIFY_WORKSPACE: workspacePath, ELECTRON_RUN_AS_NODE: '1' } },
    emit: () => {}, executeTool: channel.execute, persistBinding: id => { context.binding.nativeSessionId = id; },
  };
  let resumedAdapter: ProviderAdapter | undefined;
  try {
    context.prompt = `记住这个验证标记，下一轮需要回忆：${memoryMarker}。现在只回复此标记。`;
    const first = await adapter.run(context);
    report.checks.text = first.text.includes(memoryMarker) ? passed('最小文本推理完成') : failed('模型未返回所需标记');
    const nativeId = context.binding.nativeSessionId;
    context.messages = first.messages ?? [{ role: 'user', content: context.prompt }, { role: 'assistant', content: first.text }];
    context.prompt = '回忆上一轮的验证标记。调用 read_file 读取 verification.txt，然后回复回忆标记和文件中的标记。';
    context.runId = randomUUID(); context.signal = AbortSignal.timeout(timeout);
    resumedAdapter = factory(connection.provider);
    const second = await resumedAdapter.run(context);
    const recalled = second.text.includes(memoryMarker), consumed = second.text.includes(toolMarker);
    report.checks.multiTurn = recalled ? passed('第二轮正确回忆首轮标记') : failed('跨轮上下文未通过');
    let calls = 0;
    try { calls = (await readFile(join(workspacePath, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length; } catch { /* No call is a verification failure. */ }
    report.checks.tool = calls > 0 && consumed ? passed('真实 App read_file 工具回环完成') : failed('未完成实际工具调用与结果消费');
    const managed = connection.provider === 'custom' || connection.provider === 'chatgpt';
    report.checks.resume = recalled && (managed || !!nativeId && nativeId === context.binding.nativeSessionId)
      ? passed(managed ? '新适配器使用 App 工作历史恢复上下文' : '新适配器恢复原生会话并回忆首轮标记') : failed('会话恢复未通过');
    context.messages = second.messages ?? context.messages;
    await checkCancellation(resumedAdapter, context, report, timeout);
  } catch { for (const name of ['text', 'multiTurn', 'tool', 'resume']) if (report.checks[name].status === 'unverified') { report.checks[name] = failed('该步骤未完成'); break; } }
  finally { await resumedAdapter?.close?.(); await channel.close(); await rm(folder, { recursive: true, force: true }); }
}

async function checkCancellation(adapter: ProviderAdapter, context: RunContext, report: Report, timeout: number) {
  const controller = new AbortController(); let sawText = false;
  context.signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  context.runId = randomUUID(); context.prompt = '只生成一篇很长的数字序列，从一到一万逐个列出，不调用工具。';
  context.emit = event => { if (event.type === 'text' && !sawText) { sawText = true; controller.abort(new Error('verification-cancel')); } };
  try {
    await adapter.run(context);
    report.checks.cancel = controller.signal.aborted
      ? failed('收到文本后已请求取消，适配器仍返回完成结果')
      : unverified('生成已完成，未观察到可取消的活动轮次');
  }
  catch { report.checks.cancel = sawText && controller.signal.aborted ? passed('收到文本后发起取消，适配器未返回完成结果') : unverified('未观察到活动文本，无法证明取消路径'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('验证参数或准备条件无效；使用 --help 查看用法。'); process.exitCode = 1; });
}
