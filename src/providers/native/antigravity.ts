import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, ProbeContext, ProbeResult, RunContext, ProviderResult } from '../../domain/provider.js';
import { antigravityCatalog, antigravityEnvironment, resolveAntigravityModel } from './antigravity-catalog.js';
import { AntigravityCatalogCache } from './antigravity-cache.js';
import { prepareAntigravity, previousAntigravityUsage, saveAntigravityUsage } from './antigravity-config.js';
import { verifyAntigravityTeamTools } from './antigravity-tools.js';
import { runAntigravitySession } from './antigravity-session.js';
import { nativeCapabilities, recordOwnership, requireProfile, runtimeVersion, validateOwnership } from './runtime.js';
import { antigravityImagePrompt, assertImageInput } from '../images.js';

const streamArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
class ProbeFinished extends Error {}

export class AntigravityAdapter implements ProviderAdapter {
  kind = 'antigravity' as const;
  private active = new Set<AbortController>();
  private catalog = new AntigravityCatalogCache();

  async probe(context: ProbeContext): Promise<ProbeResult> {
    const executable = this.executable(context.connection.executable), profile = requireProfile(context.connection);
    const cwd = join(profile, 'agy-probe'); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const [models, version] = await Promise.all([this.catalog.read(executable, context.connection.revision, cwd, context.signal, true),
      runtimeVersion(executable, homedir(), context.signal)]);
    try {
      await runAntigravitySession({ executable, args: streamArgs, env: antigravityEnvironment(), cwd,
        prompt: '', signal: context.signal, beforePrompt: async () => { throw new ProbeFinished(); } });
      throw new Error('agy 未完成原生协议初始化');
    } catch (error) { if (!(error instanceof ProbeFinished)) throw error; }
    return { models: antigravityCatalog(models), version, capabilities: { ...nativeCapabilities(),
      tools: 'supported', resume: 'supported', imageInput: 'supported', permissionEnforcement: 'native-cli' } };
  }

  async run(context: RunContext): Promise<ProviderResult> {
    assertImageInput(context, context.images ?? []);
    if (context.images?.length && !context.tools.some(tool => tool.name === 'read_artifact')) {
      throw new Error('agy 读取图片需要授权 read_artifact 工具；附件已保留');
    }
    await validateOwnership(context);
    const executable = this.executable(context.connection.executable), cwd = await prepareAntigravity(context);
    const catalogStarted = Date.now();
    const models = await this.catalog.read(executable, context.connection.revision, cwd, context.signal);
    const model = resolveAntigravityModel(models, context.bot.model, context.bot.reasoning);
    context.emit({ type: 'status', data: { phase: 'runtime-prepare', stage: 'model-catalog', durationMs: Date.now() - catalogStarted } });
    const controller = new AbortController(); this.active.add(controller);
    const signal = AbortSignal.any([context.signal, controller.signal]);
    try {
      const result = await runAntigravitySession({ executable, cwd, signal, args: [...streamArgs,
        '--agent', 'multi-ai-work', '--model', model, '--add-dir', context.workspacePath],
        env: { ...antigravityEnvironment(), ...context.nativeMcp.env }, prompt: antigravityImagePrompt(context.prompt, context.images ?? []),
        expectedSessionId: context.binding.nativeSessionId, previousUsage: await previousAntigravityUsage(context),
        inputSignal: context.inputSignal, isWaitingForInput: context.isWaitingForInput,
        userInput: context.userInput,
        validateInput: messages => {
          const images = messages.flatMap(message => message.images ?? []);
          assertImageInput(context, images);
          if (images.length && !context.tools.some(tool => tool.name === 'read_artifact'))
            throw new Error('agy 读取图片需要授权 read_artifact 工具；附件已保留');
        },
        onEvent: context.emit, beforePrompt: async init => {
          if (await realpath(init.cwd) !== await realpath(cwd)) throw new Error('agy 原生会话目录不匹配');
          if (init.agent !== 'multi-ai-work') throw new Error('agy 未加载当前智能体的工作指令');
          const toolsStarted = Date.now();
          await verifyAntigravityTeamTools(context, signal);
          context.emit({ type: 'status', data: { phase: 'runtime-prepare', stage: 'team-tools', durationMs: Date.now() - toolsStarted } });
          signal.throwIfAborted();
          await recordOwnership(context, init.conversationId);
          context.emit({ type: 'status', data: { permissionOwner: 'native-cli', permissionMode: init.permissionMode } });
        } });
      await saveAntigravityUsage(context, result.nativeSessionId, result.cumulativeUsage);
      return { text: result.text, usage: result.usage, nativeSessionId: result.nativeSessionId, outcome: result.outcome };
    } finally { this.active.delete(controller); }
  }

  private executable(value?: string): string {
    if (!value) throw new Error('未找到 agy，请在连接页面检测本机安装或查看官方安装指引');
    return value;
  }
  async close(): Promise<void> {
    for (const controller of this.active) controller.abort(new Error('agy 运行已停止'));
  }
}
