import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { AuthenticationRequiredError } from '../src/domain/provider.js';
import { AntigravityAdapter } from '../src/providers/native/antigravity.js';
import { antigravityCatalog, parseAntigravityCatalog, readAntigravityCatalog, resolveAntigravityModel } from '../src/providers/native/antigravity-catalog.js';
import { antigravityWorkspace } from '../src/providers/native/antigravity-config.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

const fixture = `
import readline from 'node:readline';
import fs from 'node:fs';
const args=process.argv.slice(2), cwd=process.cwd();
if(args.includes('--version')) { console.log('1.3.1'); process.exit(0); }
if(args.includes('models')) { console.log('gemini-test-high\\tTest (High)\\ngemini-test-low\\tTest (Low)'); process.exit(0); }
const config=JSON.parse(fs.readFileSync('.agents/mcp_config.json','utf8'));
fs.writeFileSync('launch.json',JSON.stringify({args,home:process.env.HOME,config,hasRunToken:!!process.env.AI_TEAM_RUN_TOKEN}));
const index=args.indexOf('--conversation'), resumed=index>=0, id=resumed?args[index+1]:'session-1';
const send=value=>console.log(JSON.stringify(value));
send({event:'init',conversation_id:id,init:{cwd,tools:['call_mcp_tool'],permission_mode:'always-proceed',agent:'multi-ai-work'}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.event!=='user') process.exit(2);
 const usage={input_tokens:resumed?150:100,output_tokens:resumed?15:10};
 send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'答复',usage}});
});
`;

async function context() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'multi-ai-agy-adapter-'))); folders.push(folder);
  const workspace = join(folder, 'workspace'), profile = join(folder, 'profile'), executable = join(folder, 'fixture.mjs');
  await mkdir(workspace); await mkdir(profile); await writeFile(executable, fixture);
  const events: ProviderEvent[] = [];
  const value: RunContext = { runId: 'run', workspacePath: workspace, prompt: '测试任务', instructions: '助手职责',
    connection: { id: 'connection', name: 'agy', provider: 'antigravity', executable, profilePath: profile,
      concurrency: 1, status: 'ready', models: [], revision: 1, createdAt: '' },
    bot: { id: 'bot', name: '助手', role: '研究', instructions: '', connectionId: 'connection', model: 'gemini-test-high',
      reasoning: 'low', color: 'blue', toolNames: ['read_file'], skillIds: [], memoryMode: 'off', revision: 1, archived: false },
    binding: { id: 'binding', botId: 'bot', conversationId: 'room', connectionId: 'connection', generation: 1,
      configRevision: 1, connectionRevision: 1, workspaceId: 'workspace', lastDeliveredSequence: 0 },
    signal: AbortSignal.timeout(10000), messages: [],
    tools: [{ name: 'read_file', description: '读取已授权资料', inputSchema: { type: 'object' } }],
    nativeMcp: { command: process.execPath, args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
      fileURLToPath(new URL('../src/verification/mcp-worker.ts', import.meta.url))],
      env: { AI_TEAM_RUN_TOKEN: 'fixture-only', AI_TEAM_VERIFY_WORKSPACE: workspace, ELECTRON_RUN_AS_NODE: '1' } },
    emit: event => events.push(event), executeTool: async () => {}, getSecret: async () => undefined,
    saveSecret: async () => {}, persistBinding: sessionId => { value.binding.nativeSessionId = sessionId; } };
  return { value, events, folder };
}

describe('Antigravity CLI 接入', () => {
  it('按本机目录合并模型档位，发送真实存在的 variant ID，拒绝未知模型和档位', () => {
    const models = parseAntigravityCatalog('gemini-test-high\tTest (High)\ngemini-test-low\tTest (Low)\nplain\tPlain');
    expect(antigravityCatalog(models)).toEqual([{ id: 'gemini-test-high', name: 'Test', reasoning: ['low', 'high'], reasoningSource: 'provider' },
      { id: 'plain', name: 'Plain' }]);
    expect(resolveAntigravityModel(models, 'gemini-test-high', 'low')).toBe('gemini-test-low');
    expect(() => resolveAntigravityModel(models, 'gemini-test-high', 'max')).toThrow('推理强度');
    expect(() => resolveAntigravityModel(models, 'missing')).toThrow('目录');
  });

  it('保留本机 HOME，使用独立 App MCP 与指令，精确续接并按累计差值报告本轮用量', async () => {
    const { value } = await context(), adapter = new AntigravityAdapter();
    const first = await adapter.run(value);
    expect(first).toMatchObject({ text: '答复', nativeSessionId: 'session-1', usage: { inputTokens: 100, outputTokens: 10, source: 'reported' } });
    const cwd = antigravityWorkspace(value), launch = JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8'));
    expect(launch.home).toBe(homedir()); expect(launch.hasRunToken).toBe(true);
    expect(launch.args).toContain('gemini-test-low'); expect(launch.args).not.toContain('--dangerously-skip-permissions');
    expect(JSON.stringify(launch.config)).not.toContain('fixture-only');
    expect(await readFile(join(cwd, '.agents', 'agents', 'multi-ai-work.md'), 'utf8')).toContain('助手职责');
    const second = await adapter.run(value);
    expect(second.usage).toMatchObject({ inputTokens: 50, outputTokens: 5, source: 'reported' });
    expect(JSON.parse(await readFile(join(cwd, 'launch.json'), 'utf8')).args).toEqual(expect.arrayContaining(['--conversation', 'session-1']));
    value.binding.id = 'other';
    await expect(adapter.run(value)).rejects.toThrow('身份');
    await adapter.close();
  }, 10_000);

  it.each([
    { diagnostic: 'login required', auth: true },
    { diagnostic: 'network unreachable fixture-private', auth: false },
  ])('区分登录与连接故障，不透传原生诊断（$auth）', async ({ diagnostic, auth }) => {
    const { value } = await context();
    await writeFile(value.connection.executable!, `console.error(${JSON.stringify(diagnostic)}); process.exit(1);`);
    let error: unknown;
    try { await readAntigravityCatalog(value.connection.executable!, value.workspacePath, value.signal); } catch (failure) { error = failure; }
    expect(error instanceof AuthenticationRequiredError).toBe(auth);
    expect((error as Error).message).not.toContain('fixture-private');
  });

  it('团队 MCP 未返回完整成员授权目录时，在提交 prompt 前拒绝运行', async () => {
    const { value } = await context();
    value.tools.push({ name: 'list_bots', description: '成员目录', inputSchema: { type: 'object' } });
    const adapter = new AntigravityAdapter();
    await expect(adapter.run(value)).rejects.toThrow('成员授权不匹配');
    expect(value.binding.nativeSessionId).toBeUndefined();
    await adapter.close();
  });
});
