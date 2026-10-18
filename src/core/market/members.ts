import { z } from 'zod';
import type { AgentPreset, PresetInstallation, PresetMemberRequest, PresetMemberResult } from '../../domain/market.js';
import type { Bot, ToolConnection } from '../../domain/types.js';
import type { State } from '../state.js';
import type { EntityService } from '../entities.js';
import { required, publicError } from '../errors.js';
import { loadWorkspaceDependencies } from '../../tools/office-runtime.js';
import { combinedInstructions, requireIdleBot, validateBotSkills } from './bot-policy.js';
import { qoderServiceNames } from '../../domain/qoder-services.js';
import { avatarSchema } from '../avatars.js';

const configurationSchema = z.object({ name: z.string().trim().min(1).max(120).optional(),
  role: z.string().max(200).optional(), avatar: avatarSchema.optional(), color: z.string().optional(),
  contextWindow: z.number().int().min(1024).optional(), compactionThreshold: z.number().int().min(10).max(95).optional(),
  memoryMode: z.enum(['off', 'manual', 'propose']).optional(), skillIds: z.array(z.string()).max(100).optional(),
  connectionId: z.string().min(1), model: z.string().trim().min(1), reasoning: z.string().optional(),
  toolNames: z.array(z.string()).max(100), approvalMode: z.enum(['ask', 'auto']),
  qoderServices: z.array(z.enum(qoderServiceNames)).max(5).optional(),
  toolConnectionIds: z.array(z.string()).max(100), personalInstructions: z.string().max(20000).optional() });
const requestSchema = z.object({ requestId: z.string().min(1).max(160), installationId: z.string().min(1), configuration: configurationSchema });

export class PresetMembers {
  constructor(private state: State, private entities: EntityService) {}
  installation(id: string): PresetInstallation {
    const installation = required(this.state.storage.get<PresetInstallation>('preset_installations', id), '请先下载预设');
    if (installation.status !== 'installed') throw new Error('预设资源尚未准备完成，请重新下载或导入');
    validateBotSkills(this.state, installation);
    return installation;
  }
  async createMany(input: unknown): Promise<PresetMemberResult[]> {
    const requests = z.array(z.unknown()).min(1).max(50).parse(input), result: PresetMemberResult[] = [];
    for (const [index, value] of requests.entries()) {
      const requestId = z.object({ requestId: z.string() }).safeParse(value);
      try {
        const request = requestSchema.parse(value);
        result.push({ requestId: request.requestId, botId: (await this.create(request)).id });
      } catch (error) { result.push({ requestId: requestId.success ? requestId.data.requestId : `invalid-${index}`, error: publicError(error) }); }
    }
    return result;
  }
  private async create(request: PresetMemberRequest): Promise<Bot> {
    const s = this.state.storage, key = `market.member:${request.requestId}`;
    const previous = s.metadata<{ installationId: string; botId: string }>(key);
    if (previous) {
      if (previous.installationId !== request.installationId) throw new Error('添加请求已用于其他预设');
      return required(s.get<Bot>('bots', previous.botId), '已添加的成员不存在');
    }
    const installation = this.installation(request.installationId), config = request.configuration;
    await this.checkDependencies(installation.preset, config);
    this.installation(installation.id);
    const bot = s.transaction(() => {
      const saved = this.entities.saveBot({ ...config, name: config.name ?? installation.preset.name,
        role: config.role ?? installation.preset.role, instructions: combinedInstructions(installation.preset.instructions, config.personalInstructions),
        color: config.color ?? '#2563eb', avatar: config.avatar ?? 'cat', memoryMode: config.memoryMode ?? 'propose',
        skillIds: [...new Set([...installation.skillIds, ...config.skillIds ?? []])] }, installation.skillIds);
      const member: Bot = { ...saved, personalInstructions: config.personalInstructions,
        preset: { installationId: installation.id, presetId: installation.preset.id, version: installation.preset.version,
          source: installation.source, baseInstructions: installation.preset.instructions, managedSkillIds: installation.skillIds } };
      s.put('bots', member); s.setMetadata(key, { installationId: installation.id, botId: member.id }); return member;
    });
    this.state.changed(); return bot;
  }
  async update(installationId: string, botIds: string[]) {
    const installation = this.installation(installationId), s = this.state.storage;
    const results: { botId: string; error?: string }[] = [];
    for (const botId of [...new Set(botIds)]) {
      try {
        const before = required(s.get<Bot>('bots', botId), '成员不存在');
        if (!before.preset || before.preset.presetId !== installation.preset.id || before.preset.source !== installation.source)
          throw new Error('该预设与成员来源不匹配');
        requireIdleBot(this.state, botId);
        await this.checkDependencies(installation.preset, before);
        this.installation(installationId);
        const bot = required(s.get<Bot>('bots', botId), '成员不存在');
        if (bot.revision !== before.revision) throw new Error('成员配置已变化，请重新查看更新');
        requireIdleBot(this.state, botId);
        const extras = bot.skillIds.filter(id => !bot.preset!.managedSkillIds.includes(id));
        const updated: Bot = { ...bot, revision: bot.revision + 1,
          instructions: combinedInstructions(installation.preset.instructions, bot.personalInstructions),
          skillIds: [...new Set([...extras, ...installation.skillIds])],
          preset: { ...bot.preset!, installationId, version: installation.preset.version,
            baseInstructions: installation.preset.instructions, managedSkillIds: installation.skillIds } };
        // Preserve a user-edited role; only advance the managed role when it still matches its source.
        const old = s.get<PresetInstallation>('preset_installations', bot.preset!.installationId);
        if (old && bot.role === old.preset.role) updated.role = installation.preset.role;
        s.put('bots', updated); results.push({ botId });
      } catch (error) { results.push({ botId, error: publicError(error) }); }
    }
    this.state.changed(); return results;
  }
  detach(botId: string): Bot {
    const s = this.state.storage, bot = required(s.get<Bot>('bots', botId), '成员不存在');
    if (!bot.preset) return bot;
    requireIdleBot(this.state, botId);
    const updated = { ...bot, preset: undefined, personalInstructions: undefined, revision: bot.revision + 1 };
    s.put('bots', updated); this.state.changed(); return updated;
  }
  private async checkDependencies(preset: AgentPreset, config: { toolNames: string[]; toolConnectionIds?: string[] }) {
    if (!preset.platforms.includes(process.platform as 'darwin' | 'win32' | 'linux')) throw new Error('此预设尚未支持当前系统');
    for (const dependency of preset.dependencies.filter(item => item.required)) {
      if (dependency.kind === 'tool' && dependency.key !== 'read_skill' && !config.toolNames.includes(dependency.key)) throw new Error(`请启用能力：${dependency.label}`);
      if (dependency.kind === 'connection') {
        const connections = (config.toolConnectionIds ?? []).map(id => this.state.storage.get<ToolConnection>('tool_connections', id));
        if (!connections.some(item => item?.enabled && item.status === 'ready'
          && (item.kind === dependency.key || item.toolNames.includes(dependency.key)))) throw new Error(`请配置并授权：${dependency.label}`);
      }
      if (dependency.kind === 'runtime') {
        if (dependency.key !== 'office') throw new Error(`需要配置运行环境：${dependency.label}`);
        await loadWorkspaceDependencies();
      }
    }
  }
}
