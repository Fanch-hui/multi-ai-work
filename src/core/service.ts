import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Artifact, Bot, Connection, ContextCheckpoint, Conversation, MemoryEntry, ProcessRecord, Run, Task, UserQuestion } from '../domain/types.js';
import { AuthenticationRequiredError, type ProviderAdapter } from '../domain/provider.js';
import { MemoryService } from '../runtime/memory.js';
import { ContextManager } from '../runtime/context.js';
import { createNativeAdapters } from '../providers/native/index.js';
import { detectNativeSetup, type NativeSetup } from '../providers/native/setup.js';
import { ChatGptAdapter, CustomApiAdapter } from '../providers/managed/index.js';
import { supplementChatGptCatalog } from '../providers/managed/catalog.js';
import { createToolRegistry } from '../tools/index.js';
import { Vault, type CipherHost } from '../security/vault.js';
import { OAuthManager } from '../security/oauth.js';
import { State, id, now } from './state.js';
import { EntityService } from './entities.js';
import { TeamService } from './team.js';
import { TaskService, terminal } from './tasks.js';
import { ApprovalService } from './approvals.js';
import { ToolRuntime } from './tool-runtime.js';
import { Executor } from './executor.js';
import { Scheduler } from './scheduler.js';
import { BackupService } from './backup.js';
import { importAttachment, importAttachmentBytes } from './attachments.js';
import { resolveArtifactImage } from '../tools/images.js';
import { accessibleArtifacts } from './tool-access.js';
import { publicError, required } from './errors.js';
import { migrateContextSettings } from './context-settings.js';
import { migrateProviders } from './provider-migrations.js';
import { ConversationService } from './conversations.js';
import { MemoryManagement } from './memories.js';
import { avatarSchema } from './avatars.js';
import { publicBot } from './chief.js';
import { QuestionDecisions } from './question-decisions.js';
import { syncOfficeSkills } from './skills.js';
import { ToolConnections } from './tool-connections.js';
import { ConnectionLogin } from './connection-login.js';
import { completeOnboarding, skipOnboarding } from './onboarding.js';
import { MarketService } from './market/service.js';
import type { PresetInstallation } from '../domain/market.js';
import { ArtifactPreviews } from './artifact-preview.js';
import { readConversation } from './conversation-read.js';
import { TaskControlService } from './task-control.js';
import { inspectTask } from './task-inspection.js';
import { deleteArtifact } from './artifact-delete.js';
import { MAX_MESSAGE_ATTACHMENTS, requireAttachmentCapacity } from '../domain/attachment-policy.js';
import { MaintenanceAdmission } from './maintenance-admission.js';
import { createStorageMemoryStore, ensureMemoryContentHashes } from './memory-storage.js';

export type HostRequest = (method: 'chooseDirectory' | 'chooseFile' | 'chooseAvatar' | 'openPath', params?: Record<string, unknown>) => Promise<unknown>;
export class CoreService {
  readonly state: State; readonly vault: Vault; readonly entities: EntityService;
  readonly tasks: TaskService; readonly approvals: ApprovalService; readonly tools: ToolRuntime;
  readonly executor: Executor; readonly scheduler: Scheduler; readonly memory: MemoryService;
  readonly team: TeamService;
  readonly conversations: ConversationService; readonly memories: MemoryManagement;
  readonly questionDecisions: QuestionDecisions;
  readonly market: MarketService;
  readonly previews: ArtifactPreviews;
  private toolConnections: ToolConnections;
  private logins: ConnectionLogin;
  private oauth: OAuthManager; private backup: BackupService;
  private registry = createToolRegistry(); private adapters: ProviderAdapter[];
  private maintenance = false;
  private admission: MaintenanceAdmission;
  constructor(dataDirectory: string, cipher?: CipherHost, private host?: HostRequest, adapters?: ProviderAdapter[]) {
    this.state = new State(dataDirectory); const s = this.state.storage;
    this.vault = new Vault(join(dataDirectory, 'credentials.enc.json'), cipher);
    this.adapters = adapters ?? [...createNativeAdapters(), new ChatGptAdapter(), new CustomApiAdapter()];
    this.entities = new EntityService(this.state, this.vault); this.tasks = new TaskService(this.state);
    this.team = new TeamService(this.state, this.entities);
    this.approvals = new ApprovalService(this.state);
    this.memory = new MemoryService(createStorageMemoryStore(s));
    this.memories = new MemoryManagement(this.state, this.memory, this.tasks);
    const context = new ContextManager({ getCheckpoint: bindingId => s.byField<ContextCheckpoint>('context_checkpoints', 'bindingId', bindingId).at(-1),
      saveCheckpoint: cp => s.put('context_checkpoints', cp), recordCompaction: record => { s.put('compactions', record); this.state.changed(); } });
    this.tools = new ToolRuntime(this.state, this.registry, this.tasks, this.approvals, this.memory, this.team, this.memories);
    this.executor = new Executor(this.state, this.tasks, this.tools, this.memory, context, this.vault, this.adapters);
    this.scheduler = new Scheduler(this.state, this.tasks, this.executor, this.adapters);
    this.tools.controls = new TaskControlService(this.state, this.tasks, this.scheduler);
    this.questionDecisions = new QuestionDecisions(this.state, this.tasks);
    this.conversations = new ConversationService(this.state, this.tasks, this.scheduler);
    this.oauth = new OAuthManager(this.vault, { get: key => s.metadata(key), set: (key, value) => s.setMetadata(key, value) });
    this.logins = new ConnectionLogin(this.state, this.oauth);
    this.toolConnections = new ToolConnections(this.state, this.entities, this.vault, this.registry);
    this.backup = new BackupService(this.state);
    this.market = new MarketService(this.state, this.entities);
    this.previews = new ArtifactPreviews(this.state);
    this.admission = new MaintenanceAdmission(this.state, this.tasks, this.scheduler, this.tools.processes);
  }
  async start() { await this.vault.load(); this.tools.processes.recover(); this.scheduler.start(); this.memories.start(); this.questionDecisions.start(); }
  async close() {
    this.logins.close(); await this.toolConnections.close();
    this.questionDecisions.close(); this.memories.close(); this.oauth.close();
    await this.market.quiesce(); await this.previews.close(); await this.scheduler.close();
    await this.tools.processes.close(); await this.registry.close(); await this.vault.flush(); this.vault.clear(); this.state.storage.close();
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'system.prepareUpdate' || method === 'system.prepareDataDirectoryChange') {
      if (this.maintenance) throw new Error('正在处理备份，请稍后再试');
      return this.admission.prepare(method === 'system.prepareUpdate' ? 'update' : 'data-directory');
    }
    if (method === 'system.releaseUpdate' || method === 'system.releaseDataDirectoryChange') {
      this.admission.release(method === 'system.releaseUpdate' ? 'update' : 'data-directory'); return { released: true };
    }
    return this.admission.request(method, () => this.handleRequest(method, params));
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.maintenance && method !== 'state.snapshot') throw new Error('正在恢复备份，请稍后操作');
    if (method.startsWith('market.') || method === 'career.save') {
      if (method === 'market.import' && !params.path) {
        if (!this.host) throw new Error('导入预设需要桌面文件选择器或本地文件路径');
        const selection = await this.host('chooseFile') as { path?: string } | string | null;
        const path = typeof selection === 'string' ? selection : selection?.path;
        if (!path) return { cancelled: true };
        params = { ...params, path };
      }
      return this.market.request(method, params);
    }
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'questions.answer': {
        const question = this.tools.questions.answer(objectId(), params.answer);
        if (question.chiefTaskId) await this.scheduler.cancel(question.chiefTaskId);
        return question;
      }
      case 'questions.cancel': {
        const question = required(s.get<UserQuestion>('questions', objectId()), '问题不存在');
        if (question.status === 'answered') throw new Error('问题已经回答');
        await this.scheduler.cancel(question.taskId); this.tools.questions.cancelTask(question.taskId); return { cancelled: true };
      }
      case 'state.snapshot': return this.state.snapshot();
      case 'state.view': return this.state.sync.view(z.string().optional().parse(params.conversationId),
        z.number().int().positive().optional().parse(params.from));
      case 'state.changes': return this.state.sync.delta(z.object({ epoch: z.string(), version: z.number().int().nonnegative(),
        eventSequence: z.number().int().nonnegative().optional() }).parse(params.cursor),
        z.string().optional().parse(params.conversationId));
      case 'conversations.messages': {
        const room = required(s.get<Conversation>('conversations', objectId()), '对话不存在');
        return s.messagePage(room.id, z.number().int().positive().optional().parse(params.before),
          z.number().int().min(1).max(200).optional().parse(params.limit));
      }
      case 'messages.get': return z.array(z.string()).max(200).parse(params.ids).map(id => s.getMessage(id)).filter(Boolean);
      case 'conversations.read': {
        const changed = readConversation(s, objectId(), z.array(z.string()).parse(params.messageIds));
        if (changed) this.state.changed();
        return { ok: true };
      }
      case 'onboarding.skip': return skipOnboarding(this.state);
      case 'onboarding.complete': return completeOnboarding(this.state, this.team, params.input);
      case 'runs.events': {
        const run = required(s.get<Run>('runs', objectId()), '运行记录不存在');
        return s.runEvents(run.id, z.number().int().positive().optional().parse(params.cursor),
          z.number().int().min(1).max(200).optional().parse(params.limit));
      }
      case 'connections.save': {
        const connection = await this.entities.saveConnection(params.input);
        this.logins.cancel(connection.id); return connection;
      }
      case 'connections.probe': return this.probe(objectId());
      case 'connections.login': return this.login(objectId());
      case 'connections.logout': return this.logout(objectId());
      case 'connections.delete': {
        const connectionId = objectId(); this.logins.cancel(connectionId); await this.scheduler.cancelConnection(connectionId);
        const connection = s.get<Connection>('connections', connectionId);
        if (connection?.secretRef) await this.vault.delete(connection.secretRef);
        this.oauth.cancel(connectionId); s.delete('connections', connectionId); break;
      }
      case 'bots.save': {
        await this.refreshBotContextCatalog(params.input);
        return publicBot(this.entities.saveBot(params.input), this.state.settings().mainBotId);
      }
      case 'chief.configure': {
        const current = s.get<Bot>('bots', this.state.settings().mainBotId!);
        await this.refreshBotContextCatalog(params.input, current);
        return publicBot(this.team.configureChief(params.input, z.string().optional().parse(params.workspaceId)), this.state.settings().mainBotId);
      }
      case 'chief.conversations.create': return this.team.createChiefConversation(z.string().trim().min(1).max(120).optional().parse(params.name),
        z.object({ workspaceId: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional() }).parse(params));
      case 'chief.conversations.update': return this.team.updateChiefConversation(objectId(),
        z.object({ model: z.string().optional(), reasoning: z.string().optional() }).parse(params));
      case 'chief.conversations.catalog': {
        const chief = required(s.get<Bot>('bots', this.state.settings().mainBotId!), '主智能体不存在');
        const connection = required(s.get<Connection>('connections', chief.connectionId), '请先配置主管连接');
        if (connection.provider !== 'chatgpt' || connection.status !== 'ready') return connection;
        const models = await supplementChatGptCatalog(connection.models);
        const current = required(s.get<Connection>('connections', connection.id), '连接不存在');
        if (current.revision !== connection.revision) return current;
        const updated = { ...current, models };
        s.put('connections', updated); this.state.changed(); return updated;
      }
      case 'avatars.import': {
        if (!this.host) throw new Error('上传头像需要桌面图片选择器');
        return this.host('chooseAvatar');
      }
      case 'bots.clone': return this.entities.cloneBot(objectId());
      case 'bots.archive': {
        const bot = required(s.get<Bot>('bots', objectId()), '智能体不存在');
        if (bot.id === this.state.settings().mainBotId) throw new Error('主智能体需要保留，请调整其配置');
        for (const task of s.all<Task>('tasks').filter(task => task.botId === bot.id && !terminal(task.status))) await this.scheduler.cancel(task.id);
        s.put('bots', { ...bot, archived: true }); this.state.syncMainTeam(); break;
      }
      case 'conversations.create': return this.entities.createConversation(params);
      case 'conversations.rename': return this.conversations.rename(objectId(), z.string().parse(params.name));
      case 'conversations.archive': return this.conversations.archive(objectId(), z.boolean().parse(params.archived));
      case 'conversations.delete': return this.conversations.delete(objectId());
      case 'conversations.members.update': return this.conversations.updateMembers(objectId(), z.array(z.string()).max(50).parse(params.memberIds));
      case 'conversations.send': return this.tasks.send(z.object({ conversationId: z.string(), content: z.string().max(100000),
        targetBotIds: z.array(z.string()).optional(), artifactIds: z.array(z.string()).optional(), requestId: z.string().optional() }).parse(params));
      case 'conversations.attach': {
        const conversationId = z.string().parse(params.conversationId);
        const attachmentCount = z.number().int().min(0).max(MAX_MESSAGE_ATTACHMENTS).default(0).parse(params.attachmentCount);
        required(s.get('conversations', conversationId), '对话不存在');
        requireAttachmentCapacity(attachmentCount, 1);
        if (!this.host) throw new Error('添加资料需要桌面文件选择器');
        const selection = await this.host('chooseFile', { multiple: true }) as { path?: string; paths?: string[] };
        const paths = selection.paths ?? (selection.path ? [selection.path] : []);
        if (!paths.length) return { cancelled: true };
        requireAttachmentCapacity(attachmentCount, paths.length);
        const artifacts: Artifact[] = [], errors: string[] = [];
        for (const path of paths) {
          try { artifacts.push(await importAttachment(this.state, conversationId, path)); }
          catch (error) { errors.push(publicError(error)); }
        }
        return { artifacts, artifact: artifacts[0], errors };
      }
      case 'conversations.attachBytes': {
        const input = z.object({ conversationId: z.string(), name: z.string().min(1).max(255),
          mimeType: z.string().max(120), data: z.string().max(36 * 1024 * 1024) }).parse(params);
        return { artifact: await importAttachmentBytes(this.state, input.conversationId, input.name, input.mimeType, input.data) };
      }
      case 'tasks.cancel': return this.scheduler.cancel(objectId());
      case 'tasks.inspect': return inspectTask(this.state, required(s.get<Task>('tasks', objectId()), '任务不存在'));
      case 'tasks.retry': return this.tasks.retry(objectId());
      case 'tasks.reconcile': return this.tools.controls!.reconcile(objectId(), z.enum(['succeeded', 'not_executed']).parse(params.outcome));
      case 'approvals.resolve': this.approvals.resolve(objectId(), z.boolean().parse(params.approved)); break;
      case 'memories.propose': return this.memories.propose(params);
      case 'memories.save': return this.memories.save(params, { kind: 'user' });
      case 'memories.pin': return this.memories.pin(objectId(), z.boolean().parse(params.pinned));
      case 'memories.merge': return this.memories.merge(params, { kind: 'user' });
      case 'memories.history': return this.memories.history(objectId());
      case 'memories.consolidate': return this.memories.consolidate(z.object({
        scope: z.enum(['bot', 'team', 'shared']).optional(),
        ownerId: z.string().optional(),
      }).parse(params));
      case 'memories.resolve': this.memory.resolve(objectId(), z.boolean().parse(params.approved)); break;
      case 'memories.revoke': return this.memories.revoke(objectId(), { kind: 'user' });
      case 'workspaces.add': return this.entities.addWorkspace(params);
      case 'tools.save': return this.toolConnections.save(params.input);
      case 'tools.probe': return this.toolConnections.probe(objectId());
      case 'tools.delete': await this.toolConnections.delete(objectId()); break;
      case 'skills.import': return this.entities.importSkill(z.string().parse(params.path));
      case 'skills.delete': {
        if (s.get<{ bundled?: boolean }>('skills', objectId())?.bundled) throw new Error('内置 Office 技能由应用提供');
        if (s.all<Bot>('bots').some(bot => bot.skillIds.includes(objectId()))
          || s.all<PresetInstallation>('preset_installations').some(item => item.skillIds.includes(objectId())))
          throw new Error('技能仍被成员或预设引用，请先解除引用');
        s.delete('skills', objectId()); break;
      }
      case 'settings.save': {
        const input = z.object({ maxActiveRuns: z.number().int().min(1).max(15), maxChildren: z.number().int().min(1).max(30),
          maxCoordinationRounds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          autoAnswerMemberQuestions: z.boolean(), trayEnabled: z.boolean(), userAvatar: avatarSchema,
          defaultSearchConnectionId: z.string().nullable().transform(value => value ?? undefined) }).partial().parse(params.input);
        if (input.defaultSearchConnectionId) required(s.get('tool_connections', input.defaultSearchConnectionId), '搜索连接不存在');
        s.setMetadata('settings', { ...this.state.settings(), ...input });
        if (input.autoAnswerMemberQuestions === false)
          for (const task of s.all<Task>('tasks').filter(item => item.kind === 'question-decision' && !terminal(item.status))) await this.scheduler.cancel(task.id);
        break;
      }
      case 'backup.create': {
        this.maintenance = true;
        await this.market.quiesce();
        try { return await this.backup.create(); } finally { this.market.resume(); this.maintenance = false; }
      }
      case 'backup.restore': {
        if (this.scheduler.hasActive()) throw new Error('请先停止所有运行，再恢复备份');
        this.maintenance = true; this.scheduler.pause();
        await this.market.quiesce();
        try { const result = await this.backup.restore(z.string().parse(params.path)); migrateProviders(s); migrateContextSettings(s); ensureMemoryContentHashes(s); this.state.syncMainTeam(); syncOfficeSkills(this.state); return result; }
        finally { this.market.resume(); this.scheduler.resume(true); this.maintenance = false; this.state.changed(); }
      }
      case 'artifacts.read': {
        const artifact = required(s.get<Artifact>('artifacts', objectId()), '成果不存在');
        if (!['text/plain', 'text/markdown', 'application/json'].includes(artifact.mimeType)) return { path: artifact.path, binary: true };
        const content = await readFile(artifact.path, 'utf8'); return { content: content.slice(0, 100000), path: artifact.path };
      }
      case 'artifacts.open': {
        const artifact = required(s.get<Artifact>('artifacts', objectId()), '成果不存在');
        return this.host ? this.host('openPath', { path: artifact.path }) : { path: artifact.path };
      }
      case 'artifacts.delete': return deleteArtifact(this.state, objectId(), this.previews);
      case 'artifacts.previewDocument': return this.previews.describe(objectId());
      case 'artifacts.previewPage': return this.previews.page(objectId(), z.number().int().positive().parse(params.page));
      case 'processes.output': return required(this.tools.processes.output(objectId()), '命令记录不存在');
      case 'artifacts.preview': {
        const artifact = required(s.get<Artifact>('artifacts', objectId()), '成果不存在');
        if (params.conversationId) {
          const room = required(s.get<Conversation>('conversations', z.string().parse(params.conversationId)), '对话不存在');
          const visible = [...accessibleArtifacts(this.state, room, room.chiefId ?? room.memberIds[0]),
            ...s.byField<Task>('tasks', 'conversationId', room.id)
              .flatMap(task => accessibleArtifacts(this.state, room, task.botId, task))];
          if (!visible.some(item => item.id === artifact.id)) throw new Error('图片不在当前会话授权范围');
        }
        const image = await resolveArtifactImage(artifact);
        s.put('artifacts', artifact); return image;
      }
      case 'dialogs.chooseDirectory': return this.host ? this.host('chooseDirectory') : { path: undefined };
      case 'dialogs.chooseFile': return this.host ? this.host('chooseFile') : { path: undefined };
      default: throw new Error('不支持的应用操作');
    }
    this.state.changed(); return { ok: true };
  }

  private async refreshBotContextCatalog(input: unknown, current?: Bot) {
    const fields = z.object({ connectionId: z.string().optional(), model: z.string().optional(),
      contextWindow: z.number().optional() }).parse(input);
    const window = fields.contextWindow ?? current?.contextWindow;
    const connection = this.state.storage.get<Connection>('connections', fields.connectionId ?? current?.connectionId ?? '');
    if (!window || connection?.provider !== 'chatgpt' || connection.status !== 'ready') return;
    const model = connection.models.find(item => item.id === (fields.model ?? current?.model));
    if (!model || model.maxContextWindow !== undefined || !model.contextWindow || window <= model.contextWindow) return;
    await this.probe(connection.id);
  }

  private async probe(connectionId: string) {
    const s = this.state.storage;
    let connection = required(s.get<Connection>('connections', connectionId), '连接不存在');
    const adapter = required(this.adapters.find(item => item.kind === connection.provider), '连接类型不支持');
    try {
      if (connection.provider === 'antigravity' || connection.provider === 'qoder') {
        const setup = await this.nativeSetup(connection);
        if (!setup.executable) throw new Error('未找到原生运行时，请点击登录查看安装指引。');
        connection = { ...connection, executable: setup.executable,
          executableMode: connection.executableMode ?? (connection.executable ? 'explicit' : 'auto'),
          revision: connection.executable && connection.executable !== setup.executable ? connection.revision + 1 : connection.revision };
      }
      const result = await adapter.probe({ connection, signal: AbortSignal.timeout(45000), getSecret: ref => this.vault.get(ref), saveSecret: (ref, value) => this.vault.set(ref, value) });
      const updated = { ...connection, ...result, status: 'ready' as const, error: undefined };
      s.put('connections', updated); this.state.changed(); return updated;
    } catch (error) {
      s.put('connections', { ...connection, status: error instanceof AuthenticationRequiredError ? 'needs_auth' : 'error', error: publicError(error) });
      this.state.changed(); throw error;
    }
  }
  private async login(connectionId: string) {
    let connection = required(this.state.storage.get<Connection>('connections', connectionId), '连接不存在');
    if (connection.provider === 'custom') throw new Error('自定义 API 请在连接配置中填写凭据。');
    await this.scheduler.cancelConnection(connectionId);
    if (connection.provider === 'chatgpt') return this.logins.start(connectionId);
    connection = { ...connection, revision: connection.revision + 1, status: 'needs_auth', error: undefined };
    this.state.storage.put('connections', connection); this.state.changed();
    let setup: NativeSetup;
    try { setup = await this.nativeSetup(connection); }
    catch (error) {
      this.state.storage.put('connections', { ...connection, status: 'error', error: publicError(error) });
      this.state.changed(); throw error;
    }
    connection = { ...connection, executable: setup.executable,
      executableMode: connection.executableMode ?? (connection.executable ? 'explicit' : 'auto'), status: setup.executable ? 'needs_auth' : 'error',
      error: setup.executable ? undefined : '未找到原生运行时，请查看安装指引或指定运行时路径。' };
    this.state.storage.put('connections', connection); this.state.changed();
    return { instructions: setup.executable ? connection.provider === 'antigravity'
      ? '已找到本机 agy。已有登录可直接检测连接；尚未登录时，在终端运行下面的命令并完成官方授权，再回到这里检测。原生工具权限沿用 agy 设置，App 管理团队操作权限。'
      : '已找到本机 Qoder CN。已有登录可直接检测连接；尚未登录时，在终端运行下面的命令完成官方登录，再回到这里检测。'
      : connection.provider === 'antigravity' ? '未找到 agy。请在终端运行以下官方安装命令，安装并登录后检测连接。'
        : '未找到运行时。请用已安装的 Node.js 执行以下安装命令，完成后再次点击登录。',
      command: setup.loginCommand ?? setup.installCommand };
  }
  private async logout(connectionId: string) {
    this.logins.cancel(connectionId);
    await this.scheduler.cancelConnection(connectionId);
    const connection = required(this.state.storage.get<Connection>('connections', connectionId), '连接不存在');
    const result = connection.provider === 'chatgpt' ? await this.oauth.signOut(connectionId) : { remoteRevocationConfirmed: false };
    if (connection.secretRef) await this.vault.delete(connection.secretRef);
    this.state.storage.put('connections', { ...connection, secretRef: undefined, status: 'needs_auth', revision: connection.revision + 1 });
    this.state.changed(); return result;
  }
  private nativeSetup(connection: Connection) {
    return detectNativeSetup({ provider: connection.provider as 'antigravity' | 'qoder', executable: connection.executableMode === 'auto' ? undefined : connection.executable,
      profilePath: connection.profilePath!, appRuntimeDirectory: join(this.state.dataDirectory, 'runtimes') });
  }
}
