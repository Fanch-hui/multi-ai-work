// Portions adapted from Codex Bridge and modified for App-owned sessions and tools.
// Copyright 2026 Codex Bridge contributors. Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { createRequire } from 'node:module';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as QoderSdk from '@qodercn-ai/qodercn-agent-sdk';
import { AuthenticationRequiredError, type ProviderAdapter, type RunContext, type ProbeContext, type ProbeResult, type ProviderResult } from '../../domain/provider.js';
import type { ModelInfo, Connection } from '../../domain/types.js';
import { NativeInput } from './input.js';
import { QoderEvents } from './qoder-events.js';
import { qoderAuthDirectory, qoderEnvironment, qoderProbeError } from './qoder-runtime.js';
import { accountDigest, bounded, launch, stop, nativeCapabilities, requireProfile, recordOwnership, runtimeVersion, validateOwnership, validateOwnedAccount } from './runtime.js';
import { qoderImageContent } from '../images.js';
import { qoderModelPolicy, qoderServiceOptions } from './qoder-services.js';
import { QoderInput } from './qoder-input.js';

type Sdk = typeof QoderSdk;
export type QoderLoader = () => Promise<Sdk>;
export function qoderCatalog(models: QoderSdk.ModelInfo[]): ModelInfo[] {
  return models.filter(model => model.isEnabled !== false).map(model => ({ id: model.value,
    name: model.displayName ?? model.value,
    contextWindow: model.defaultContextWindow ?? Object.values(model.context_config ?? {}).find(value => value.is_default)?.token_count,
    reasoning: model.efforts ?? Object.keys(model.thinking_config?.enabled?.efforts ?? {}),
    ...(typeof model.isVl === 'boolean' ? { imageInput: model.isVl ? 'supported' as const : 'unsupported' as const,
      imageInputSource: 'provider' as const } : {}) }));
}

export function qoderOptions(connection: Connection, profile: string, cwd: string, sdk: Sdk, secret?: string,
  children?: Set<ChildProcessWithoutNullStreams>): QoderSdk.Options {
  if (connection.authMode !== 'local' && !secret) throw new AuthenticationRequiredError('Qoder 需要本机官方登录或已保存的访问令牌');
  return { auth: connection.authMode === 'local' ? sdk.qodercliAuth() : sdk.accessToken(secret!), cwd, env: qoderEnvironment(profile),
    ...(connection.executable ? { pathToQoderCLIExecutable: connection.executable } : {}),
    transport: sdk.ProcessTransport.default, permissionMode: 'default', tools: [], skills: [], agents: {},
    memory: {}, evolution: {}, plugins: [], settingSources: [], settings: {}, strictMcpConfig: true,
    persistSession: true, includePartialMessages: true, controlRequestTimeoutMs: 30000,
    spawnQoderCLIProcess: spawnOptions => {
      const child = launch(spawnOptions.command === 'node' ? process.execPath : spawnOptions.command,
        spawnOptions.args, spawnOptions.cwd ?? cwd, { ...spawnOptions.env, ELECTRON_RUN_AS_NODE: '1' });
      children?.add(child); return child;
    },
    canUseTool: async () => ({ behavior: 'deny', message: '请通过 multi-AI work 工具执行操作' }),
  };
}

async function loadSdk(): Promise<Sdk> {
  const resolver = createRequire(import.meta.url);
  const entry = resolver.resolve('@qodercn-ai/qodercn-agent-sdk');
  const manifest = JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8'));
  if (manifest.qoderSdkBrand !== 'cn') throw new Error('Qoder SDK 区域不匹配，需要 CN 版本');
  return import('@qodercn-ai/qodercn-agent-sdk');
}

export const QODER_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
interface QoderModelCacheEntry {
  models: ModelInfo[];
  accountScope: string;
  expiresAt: number;
}
const qoderModelCache = new Map<string, QoderModelCacheEntry>();
const qoderModelInFlight = new Map<string, Promise<QoderSdk.ModelInfo[]>>();

export function clearQoderModelCache(): void {
  qoderModelCache.clear();
  qoderModelInFlight.clear();
}

function qoderCacheKey(connection: Connection, profile: string, options: QoderSdk.Options): string {
  return JSON.stringify([
    connection.id,
    connection.revision,
    connection.authMode,
    connection.executable ?? '',
    profile,
    options.env?.QODER_SDK_AUTH_CONFIG_DIR ?? '',
    options.env?.QODERCN_CONFIG_DIR ?? '',
    options.env?.HOME ?? '',
    connection.accountScope ?? '',
  ]);
}

function readQoderModelCache(key: string): QoderModelCacheEntry | undefined {
  const entry = qoderModelCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    qoderModelCache.delete(key);
    return undefined;
  }
  return entry;
}

function fetchQoderModels(key: string, query: QoderSdk.Query, signal: AbortSignal): Promise<QoderSdk.ModelInfo[]> {
  let pending = qoderModelInFlight.get(key);
  if (!pending) {
    pending = query.getAvailableModels().finally(() => {
      if (qoderModelInFlight.get(key) === pending) qoderModelInFlight.delete(key);
    });
    qoderModelInFlight.set(key, pending);
  }
  return bounded(pending, signal);
}

export class QoderAdapter implements ProviderAdapter {
  kind = 'qoder' as const;
  private active = new Map<QoderSdk.Query, Set<ChildProcessWithoutNullStreams>>();
  constructor(private loader: QoderLoader = loadSdk) {}

  async probe(context: ProbeContext): Promise<ProbeResult> {
    const profile = requireProfile(context.connection);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const sdk = await this.loader();
    const children = new Set<ChildProcessWithoutNullStreams>();
    const options = await this.options(context, profile, profile, sdk, children);
    const cacheKey = qoderCacheKey(context.connection, profile, options);
    const input = new NativeInput<QoderSdk.SDKUserMessage>();
    const query = sdk.query({ prompt: input, options: { ...options, persistSession: false, sessionId: randomUUID(), mcpServers: {} } });
    this.active.set(query, children);
    let cliVersion: string | undefined;
    const drain = (async () => { for await (const message of query) if (message.type === 'system' && message.subtype === 'init') cliVersion = message.qodercli_version; })();
    void drain.catch(() => {});
    let stage: 'initialization' | 'account' | 'models' = 'initialization';
    try {
      const init = await bounded(query.initializationResult(), context.signal);
      stage = 'account';
      const account = await bounded(query.accountInfo(), context.signal);
      if (!account.userId) throw new AuthenticationRequiredError('Qoder CN 尚未登录，请在本机 CLI 完成官方登录后再检测');
      stage = 'models';
      const models = await bounded(query.getAvailableModels({ fetchStrategy: 'live' }), context.signal);
      const capabilities = nativeCapabilities();
      capabilities.tools = 'supported'; capabilities.resume = 'supported';
      capabilities.contextUsage = init.capabilities?.includes('context_usage_v1') ? 'supported' : 'unverified';
      capabilities.imageInput = 'supported';
      capabilities.permissionEnforcement = 'mixed';
      const catalog = qoderCatalog(models);
      const accountScope = accountDigest('qoder-cn', account.userId);
      qoderModelCache.set(cacheKey, { models: catalog, accountScope, expiresAt: Date.now() + QODER_MODEL_CACHE_TTL_MS });
      return { models: catalog, capabilities, accountScope,
        version: context.connection.executable ? await runtimeVersion(context.connection.executable, profile, context.signal) : cliVersion };
    } catch (error) { context.signal.throwIfAborted(); throw qoderProbeError(error, stage); }
    finally { input.close(); await this.closeQuery(query, children); await drain.catch(() => {}); }
  }

  async run(context: RunContext): Promise<ProviderResult> {
    await validateOwnership(context);
    const sdk = await this.loader();
    const profile = requireProfile(context.connection);
    const sessionId = context.binding.nativeSessionId ?? randomUUID();
    const input = new NativeInput<QoderSdk.SDKUserMessage>();
    const children = new Set<ChildProcessWithoutNullStreams>();
    const options = await this.runOptions(context, sdk, profile, sessionId, children);
    const cacheKey = qoderCacheKey(context.connection, profile, options);
    const query = sdk.query({ prompt: input, options });
    this.active.set(query, children);
    const events = new QoderEvents(context);
    const userInput = new QoderInput(context, input, sessionId, events);
    let initialized!: () => void;
    const nativeInitialization = new Promise<void>(resolve => { initialized = resolve; });
    const result = this.consume(query, context, sessionId, events, initialized, userInput);
    // Observe stream failures even while control requests are initializing.
    void result.catch(() => {});
    const cancel = () => { void query.interrupt().catch(() => {}); };
    const inputController = new AbortController();
    const turnSignal = AbortSignal.any([context.signal, inputController.signal]);
    const preparationController = new AbortController();
    const preparationSignal = AbortSignal.any([context.signal, preparationController.signal]);
    let waiting = false;
    let interruption: Promise<unknown> | undefined;
    const pause = () => {
      if (context.signal.aborted || !context.isWaitingForInput?.()) return;
      waiting = true; interruption = query.interrupt();
      void interruption.catch(() => {});
      inputController.abort(new Error('等待用户回答'));
    };
    context.signal.addEventListener('abort', cancel, { once: true });
    try {
      preparationSignal.throwIfAborted();
      const [{ initialization, scope }, content] = await Promise.all([
        this.prepare(query, context, nativeInitialization, result, preparationSignal, cacheKey),
        bounded(qoderImageContent({ ...context, signal: preparationSignal }), preparationSignal, 30 * 60 * 1000),
      ]);
      preparationSignal.throwIfAborted();
      await recordOwnership(context, sessionId, scope);
      preparationSignal.throwIfAborted();
      input.send({ type: 'user', uuid: context.runId, session_id: sessionId, parent_tool_use_id: null,
        message: { role: 'user', content } });
      userInput.start();
      context.inputSignal?.addEventListener('abort', pause, { once: true });
      if (context.inputSignal?.aborted) pause();
      const completed = await bounded(Promise.race([result, userInput.failure]), turnSignal, 30 * 60 * 1000);
      if (initialization.capabilities?.includes('context_usage_v1')) {
        try {
          const usage = await bounded(query.getContextUsage(), context.signal, 5000);
          context.emit({ type: 'context', data: { owner: 'native', source: 'native-reported',
            usedPercentage: usage.contextWindow.usedPercentage, autoCompact: usage.autoCompact } });
        } catch { context.signal.throwIfAborted(); }
      }
      return completed;
    } catch (error) {
      context.signal.throwIfAborted();
      if (!waiting || error !== inputController.signal.reason) throw error;
      await bounded(interruption!, context.signal, 5000);
      return { text: events.text, nativeSessionId: sessionId, outcome: 'waiting_input' };
    } finally {
      preparationController.abort();
      userInput.stop();
      context.inputSignal?.removeEventListener('abort', pause);
      context.signal.removeEventListener('abort', cancel); input.close();
      await this.closeQuery(query, children); await result.catch(() => {});
    }
  }

  private async prepare(query: QoderSdk.Query, context: RunContext, nativeInitialization: Promise<void>,
    result: Promise<ProviderResult>, signal: AbortSignal, cacheKey: string) {
    const initialization = await bounded(query.initializationResult(), signal);
    await bounded(Promise.race([nativeInitialization, result.then(() => { throw new Error('Qoder 在输入前结束轮次'); })]), signal);
    const cached = readQoderModelCache(cacheKey);
    const canReuseCached = Boolean(cached
      && (!context.bot.model || cached.models.some(model => model.id === context.bot.model))
      && (!context.bot.reasoning || cached.models.find(model => model.id === context.bot.model)?.reasoning?.includes(context.bot.reasoning)));
    const [account, prefetchedModels, servers] = await Promise.all([
      bounded(query.accountInfo(), signal),
      canReuseCached ? Promise.resolve(undefined) : fetchQoderModels(cacheKey, query, signal),
      bounded(query.mcpServerStatus(), signal),
    ]);
    if (!account.userId) throw new AuthenticationRequiredError('Qoder CN 需要本机官方登录');
    const scope = accountDigest('qoder-cn', account.userId);
    await validateOwnedAccount(context, scope);
    let catalog: ModelInfo[];
    if (canReuseCached && cached?.accountScope === scope) {
      catalog = cached.models;
    } else {
      const availableModels = prefetchedModels ?? await fetchQoderModels(cacheKey, query, signal);
      catalog = qoderCatalog(availableModels);
      qoderModelCache.set(cacheKey, { models: catalog, accountScope: scope, expiresAt: Date.now() + QODER_MODEL_CACHE_TTL_MS });
    }
    this.validateModel(context, catalog);
    if (!servers.some(server => server.name === 'ai-team' && server.status === 'connected')) throw new Error('Qoder 无法连接 multi-AI work 工具');
    return { initialization, scope };
  }

  private async runOptions(context: RunContext, sdk: Sdk, profile: string, sessionId: string,
    children: Set<ChildProcessWithoutNullStreams>): Promise<QoderSdk.Options> {
    const options = await this.options(context, profile, context.workspacePath, sdk, children);
    return { ...options, ...(context.binding.nativeSessionId ? { resume: sessionId } : { sessionId }),
      model: context.bot.model || undefined,
      systemPrompt: context.instructions,
      mcpServers: { 'ai-team': { type: 'stdio', ...context.nativeMcp } },
      allowedMcpServerNames: ['ai-team'],
      resolveModel: qoderModelPolicy(context),
      ...qoderServiceOptions(context),
    };
  }

  private async options(context: ProbeContext, profile: string, cwd: string, sdk: Sdk,
    children: Set<ChildProcessWithoutNullStreams>): Promise<QoderSdk.Options> {
    const secret = context.connection.authMode === 'local' ? undefined : await context.getSecret(context.connection.secretRef);
    const options = qoderOptions(context.connection, profile, cwd, sdk, secret, children);
    if (context.connection.authMode === 'local') options.env!.QODER_SDK_AUTH_CONFIG_DIR = await qoderAuthDirectory(profile);
    return options;
  }

  private validateModel(context: RunContext, models: ModelInfo[]): void {
    const selected = models.find(model => model.id === context.bot.model);
    if (context.bot.model && !selected) throw new Error('Qoder 模型不在当前账号的可用目录中');
    if (context.bot.reasoning && !selected?.reasoning?.includes(context.bot.reasoning)) throw new Error('Qoder 不支持所选思考强度');
    if (context.images?.length && selected?.imageInput === 'unsupported') throw new Error('当前 Qoder 模型不支持图片输入，请选择支持图片的模型；附件已保留');
  }

  private async consume(query: QoderSdk.Query, context: RunContext, sessionId: string, events: QoderEvents,
    initialized: () => void, userInput: QoderInput): Promise<ProviderResult> {
    const workspace = await realpath(context.workspacePath);
    let inputTokens = 0, outputTokens = 0;
    for await (const message of query) {
      if (message.session_id && message.session_id !== sessionId) throw new Error('Qoder 返回了其他原生会话');
      if (message.type === 'system' && message.subtype === 'init') {
        if (await realpath(message.cwd) !== workspace) throw new Error('Qoder 原生工作目录不匹配');
        initialized();
      }
      userInput.accept(message);
      events.accept(message);
      if (message.type !== 'result' || message.origin?.kind === 'task-notification') continue;
      context.signal.throwIfAborted();
      if (message.subtype !== 'success' || message.is_error) throw new Error('Qoder 未完成当前轮次');
      const text = message.result || events.text;
      if (!text.trim()) throw new Error('Qoder 返回空结果');
      events.text = text;
      const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, source: 'reported' as const };
      inputTokens += usage.inputTokens; outputTokens += usage.outputTokens;
      context.emit({ type: 'usage', data: { ...usage } });
      context.emit({ type: 'status', data: { stopReason: message.terminal_reason ?? message.stop_reason } });
      await userInput.flush();
      if (userInput.hasOutstanding()) continue;
      return { text, usage: { inputTokens, outputTokens, source: 'reported' }, nativeSessionId: sessionId };
    }
    throw new Error('Qoder 输出流在最终结果前结束');
  }

  private async closeQuery(query: QoderSdk.Query, children: Set<ChildProcessWithoutNullStreams>): Promise<void> {
    const processes = [...children].map(stop);
    // Windows must inspect the tree before SDK shutdown can remove its parent PID.
    const close = process.platform === 'win32' ? Promise.allSettled(processes).then(() => query.close()) : query.close();
    const results = await Promise.allSettled([close, ...processes]);
    this.active.delete(query);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.active].map(([query, children]) => this.closeQuery(query, children)));
    this.active.clear();
  }
}
