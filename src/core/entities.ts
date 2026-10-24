import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type {
  Bot,
  Connection,
  Conversation,
  Skill,
  Task,
  ToolConnection,
  Workspace,
} from '../domain/types.js';
import { State, id, now } from './state.js';
import { Vault } from '../security/vault.js';
import { detectNativeSetup } from '../providers/native/setup.js';
import { required } from './errors.js';
import { avatarSchema } from './avatars.js';
import { chiefInstructions, chiefRole } from './chief.js';
import { chiefOnlyTools, fullToolNames } from '../domain/tool-permissions.js';
import { qoderServiceNames } from '../domain/qoder-services.js';
import { assertSkillAssignment, importSkillPackage } from './skills.js';
import { isChiefProvider } from '../domain/chief-provider.js';
import { protectPresetEdit, validateBotSkills } from './market/bot-policy.js';
import { defaultContextWindow } from '../domain/context-settings.js';
import { httpSearchConfiguration } from '../domain/tool-connection.js';
import { terminal } from '../domain/task-status.js';

const name = z.string().trim().min(1).max(120);
const connectionSchema = z.object({
  id: z.string().optional(),
  name,
  provider: z.enum(['antigravity', 'chatgpt', 'qoder', 'custom']),
  protocol: z.enum(['chat-completions', 'responses']).optional(),
  baseUrl: z.string().optional(),
  executable: z.string().optional(),
  executableMode: z.enum(['auto', 'explicit']).optional(),
  profilePath: z.string().optional(),
  authMode: z.enum(['oauth', 'local', 'pat', 'api-key', 'none']).optional(),
  secret: z.string().optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
});
const botSchema = z.object({
  id: z.string().optional(),
  name,
  role: z.string().max(200),
  instructions: z.string().max(80000),
  personalInstructions: z.string().max(20000).optional(),
  connectionId: z.string(),
  model: z.string().trim().min(1, '请选择模型'),
  reasoning: z.string().trim().min(1).max(80).optional(),
  contextWindow: z.number().int().min(1024).optional(),
  outputReserve: z.number().int().min(0).optional(),
  color: z.string().default('emerald'),
  compactionThreshold: z.number().int().min(10).max(95).optional(),
  avatar: avatarSchema.optional(),
  toolNames: z.array(z.string()).optional(),
  approvalMode: z.enum(['ask', 'auto']).optional(),
  qoderServices: z.array(z.enum(qoderServiceNames)).max(5).optional(),
  skillIds: z.array(z.string()).default([]),
  toolConnectionIds: z.array(z.string()).default([]),
  memoryMode: z.enum(['off', 'manual', 'propose']).default('propose'),
});
const toolSchema = z.object({
  id: z.string().optional(),
  name,
  kind: z.enum(['mcp', 'bridge', 'search']),
  transport: z.enum(['stdio', 'http']).optional(),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  secret: z.string().optional(),
  enabled: z.boolean().default(true),
  searchBackend: z.enum(['http', 'tavily', 'deepseek']).optional(),
  searchMethod: z.enum(['GET', 'POST']).optional(),
  searchQueryField: z.string().trim().min(1).max(120).optional(),
});

export class EntityService {
  workspaceBusy?: (workspaceId: string) => boolean;
  constructor(
    private state: State,
    private vault: Vault,
  ) {}
  async saveConnection(input: unknown): Promise<Connection> {
    const parsed = connectionSchema.parse(input);
    const connectionId = parsed.id ?? id();
    const old = this.state.storage.get<Connection>('connections', connectionId);
    const { secret, ...fields } = parsed;
    if (fields.provider === 'custom') {
      const endpoint = new URL(fields.baseUrl ?? '');
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new Error('API 地址不能含凭据或查询参数');
      if (
        endpoint.protocol !== 'https:' &&
        !(
          endpoint.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
        )
      )
        throw new Error('API 使用 HTTPS；本机服务可使用 HTTP');
    }
    const secretRef = secret ? `connection:${connectionId}` : old?.secretRef;
    if (secret && secretRef) await this.vault.set(secretRef, secret);
    let profilePath = fields.profilePath || old?.profilePath;
    let executableMode: Connection['executableMode'];
    if (['antigravity', 'qoder'].includes(fields.provider)) {
      executableMode =
        fields.executableMode ??
        (fields.executable &&
        (old?.executableMode !== 'auto' || fields.executable !== old.executable)
          ? 'explicit'
          : 'auto');
      if (executableMode === 'explicit' && !fields.executable)
        throw new Error('请填写显式运行时路径');
      profilePath ??= join(this.state.dataDirectory, 'profiles', connectionId);
      await mkdir(profilePath, { recursive: true, mode: 0o700 });
      const setup = await detectNativeSetup({
        provider: fields.provider as 'antigravity' | 'qoder',
        executable: executableMode === 'explicit' ? fields.executable : undefined,
        profilePath,
        appRuntimeDirectory: join(this.state.dataDirectory, 'runtimes'),
      });
      fields.executable = setup.executable;
    }
    const connection: Connection = {
      ...fields,
      concurrency: fields.concurrency ?? old?.concurrency ?? 5,
      id: connectionId,
      secretRef,
      profilePath,
      executableMode,
      status: 'untested',
      models: [],
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? now(),
    };
    this.state.storage.put('connections', connection);
    this.state.changed();
    return connection;
  }
  saveBot(input: unknown, presetSkillIds: readonly string[] = []): Bot {
    const parsed = botSchema.parse(input);
    if (parsed.id === this.state.settings().mainBotId) {
      parsed.role = chiefRole;
      parsed.instructions = chiefInstructions;
    }
    const connection = required(
      this.state.storage.get<Connection>('connections', parsed.connectionId),
      '模型连接不存在',
    );
    if (parsed.id === this.state.settings().mainBotId && !isChiefProvider(connection.provider))
      throw new Error('管家请选择 ChatGPT 或自定义 API 连接');
    if (connection.status !== 'ready') throw new Error('请先完成连接');
    const native = connection.provider === 'antigravity' || connection.provider === 'qoder';
    if (native) {
      parsed.contextWindow = undefined;
      parsed.outputReserve = undefined;
      parsed.compactionThreshold = undefined;
    }
    const model = connection.models.find((item) => item.id === parsed.model);
    if (connection.models.length && !model) throw new Error('当前连接不提供所选模型');
    const maximum =
      model?.maxContextWindow ??
      (connection.provider === 'chatgpt' ? undefined : model?.contextWindow);
    if (!native && parsed.contextWindow && maximum && parsed.contextWindow > maximum)
      throw new Error('上下文窗口不能超过模型支持的范围');
    if (
      parsed.reasoning &&
      model?.reasoning !== undefined &&
      !model.reasoning.includes(parsed.reasoning)
    )
      throw new Error('所选模型不支持此推理强度');
    const window = parsed.contextWindow ?? defaultContextWindow(connection.provider, model);
    const reserve = parsed.outputReserve;
    if (!native && window && reserve !== undefined && reserve >= window)
      throw new Error('回复预留须小于上下文窗口');
    const botId = parsed.id ?? id();
    const old = this.state.storage.get<Bot>('bots', botId);
    const chief = botId === this.state.settings().mainBotId;
    if (
      chief &&
      old &&
      (old.model !== parsed.model || old.connectionId !== parsed.connectionId) &&
      this.state.storage
        .byField<Task>('tasks', 'botId', botId)
        .some((task) => !terminal(task.status))
    )
      throw new Error('请先结束或停止管家的工作，再更换模型或连接');
    protectPresetEdit(this.state, old, parsed);
    validateBotSkills(this.state, parsed);
    assertSkillAssignment(this.state, parsed.skillIds, [
      ...(old?.skillIds ?? []),
      ...presetSkillIds,
    ]);
    const toolNames = [
      ...new Set(parsed.toolNames ?? old?.toolNames ?? fullToolNames(chief)),
    ].filter((name) => chief || !chiefOnlyTools.includes(name));
    const bot: Bot = {
      ...parsed,
      preset: old?.preset,
      toolNames,
      approvalMode: parsed.approvalMode ?? old?.approvalMode ?? 'auto',
      qoderServices: parsed.qoderServices ?? old?.qoderServices,
      id: botId,
      revision: (old?.revision ?? 0) + 1,
      archived: false,
    };
    this.state.storage.put('bots', bot);
    this.state.syncMainTeam();
    this.state.changed();
    return bot;
  }
  cloneBot(botId: string): Bot {
    if (botId === this.state.settings().mainBotId) throw new Error('主管智能体为内置成员');
    const bot = required(this.state.storage.get<Bot>('bots', botId), '智能体不存在');
    return this.saveBot(
      { ...bot, id: undefined, personalInstructions: undefined, name: `${bot.name} 副本` },
      bot.skillIds,
    );
  }
  createConversation(input: unknown): Conversation {
    const parsed = z
      .object({
        name,
        kind: z.enum(['private', 'group']),
        memberIds: z.array(z.string()).min(1),
        chiefId: z.string().optional(),
        workspaceId: z.string(),
      })
      .parse(input);
    const members = [...new Set(parsed.memberIds)];
    for (const botId of members) {
      const bot = required(this.state.storage.get<Bot>('bots', botId), '智能体不存在');
      if (bot.archived) throw new Error('智能体已归档');
    }
    if (parsed.kind === 'private' && members.length !== 1) throw new Error('私聊需要一个智能体');
    if (parsed.kind === 'group' && (!parsed.chiefId || !members.includes(parsed.chiefId)))
      throw new Error('请选择群成员作为 Chief');
    required(this.state.storage.get('workspaces', parsed.workspaceId), '工作目录不存在');
    const room: Conversation = { ...parsed, memberIds: members, id: id(), createdAt: now() };
    this.state.storage.put('conversations', room);
    this.state.changed();
    return room;
  }
  async addWorkspace(input: unknown): Promise<Workspace> {
    const parsed = z
      .object({ name, path: z.string(), writable: z.boolean().default(false) })
      .parse(input);
    if (!isAbsolute(parsed.path)) throw new Error('请选择绝对路径');
    const path = await realpath(parsed.path);
    const existing = this.state.storage
      .all<Workspace>('workspaces')
      .find((item) => item.path === path);
    if (existing) return this.updateWorkspace({ ...parsed, id: existing.id, enabled: true });
    const workspace: Workspace = { ...parsed, path, enabled: true, id: id() };
    this.state.storage.put('workspaces', workspace);
    this.state.changed();
    return workspace;
  }
  updateWorkspace(input: unknown): Workspace {
    const parsed = z
      .object({
        id: z.string(),
        name: name.optional(),
        writable: z.boolean().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(input);
    const current = required(
      this.state.storage.get<Workspace>('workspaces', parsed.id),
      '工作目录不存在',
    );
    const next = { ...current, ...parsed };
    if (
      next.id === this.state.settings().defaultWorkspaceId &&
      (!next.writable || next.enabled === false)
    )
      throw new Error('工作成果目录需保持可读写');
    const tightens =
      (current.writable && !next.writable) || (current.enabled !== false && next.enabled === false);
    if (tightens && this.workspaceBusy?.(next.id))
      throw new Error('工作目录正在使用，请先完成或停止命令及写入操作');
    this.state.storage.put('workspaces', next);
    this.state.changed();
    return next;
  }
  async saveTool(input: unknown): Promise<ToolConnection> {
    const parsed = toolSchema.parse(input);
    const toolId = parsed.id ?? id(),
      old = this.state.storage.get<ToolConnection>('tool_connections', toolId);
    const { secret, ...fields } = parsed;
    if (fields.kind === 'search') {
      const { method, queryField } = httpSearchConfiguration(fields);
      fields.searchBackend = 'http';
      fields.searchMethod = method;
      fields.searchQueryField = queryField;
    }
    if (fields.transport === 'stdio' && (!fields.command || !isAbsolute(fields.command)))
      throw new Error('stdio MCP 请选择可执行文件的绝对路径');
    if (fields.url) {
      const url = new URL(fields.url);
      if (url.username || url.password) throw new Error('工具连接地址不能嵌入凭据');
      if ([...url.searchParams.keys()].some((key) => /token|key|secret|authorization/i.test(key)))
        throw new Error('凭据请填写在独立凭据字段');
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('工具地址需为 HTTP 或 HTTPS');
    }
    const secretRef = secret ? `tool:${toolId}` : old?.secretRef;
    if (secret && secretRef) await this.vault.set(secretRef, secret);
    const tool: ToolConnection = {
      ...fields,
      id: toolId,
      secretRef,
      toolNames: [],
      status: 'untested',
    };
    this.state.storage.put('tool_connections', tool);
    this.state.changed();
    return tool;
  }
  async importSkill(path: string): Promise<Skill> {
    return importSkillPackage(this.state, path);
  }
}
