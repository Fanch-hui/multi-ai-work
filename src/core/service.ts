import { join } from 'node:path';
import { z } from 'zod';
import type { Bot, ContextCheckpoint, Task, UserQuestion } from '../domain/types.js';
import type { ProviderAdapter } from '../domain/provider.js';
import { MemoryService } from '../runtime/memory.js';
import { ContextManager } from '../runtime/context.js';
import { createNativeAdapters } from '../providers/native/index.js';
import { ChatGptAdapter, CustomApiAdapter } from '../providers/managed/index.js';
import { createToolRegistry } from '../tools/index.js';
import { Vault, type CipherHost } from '../security/vault.js';
import { HistoryRequests } from './history-requests.js';
import { TeamRequests } from './team-requests.js';
import { CoreConnections } from './core-connections.js';
import { ArtifactRequests, type HostRequest } from './artifact-requests.js';
import { State } from './state.js';
import { EntityService } from './entities.js';
import { TeamService } from './team.js';
import { TaskService, terminal } from './tasks.js';
import { ApprovalService } from './approvals.js';
import { ToolRuntime } from './tool-runtime.js';
import { Executor } from './executor.js';
import { Scheduler } from './scheduler.js';
import { BackupService } from './backup.js';
import { required } from './errors.js';
import { migrateContextSettings } from './context-settings.js';
import { migrateProviders } from './provider-migrations.js';
import { ConversationService } from './conversations.js';
import { MemoryManagement } from './memories.js';
import { avatarSchema } from './avatars.js';
import { QuestionDecisions } from './question-decisions.js';
import { syncOfficeSkills } from './skills.js';
import { ToolConnections } from './tool-connections.js';
import { completeOnboarding, skipOnboarding } from './onboarding.js';
import { MarketService } from './market/service.js';
import type { PresetInstallation } from '../domain/market.js';
import { ArtifactPreviews } from './artifact-preview.js';
import { TaskControlService } from './task-control.js';
import { inspectTask } from './task-inspection.js';
import { MaintenanceAdmission } from './maintenance-admission.js';
import { createStorageMemoryStore, ensureMemoryContentHashes } from './memory-storage.js';
import { queueContextCompaction } from './conversation-compaction.js';
import { migrateReplyArtifacts } from './reply-artifacts.js';

export type { HostRequest } from './artifact-requests.js';
export class CoreService {
  readonly state: State;
  readonly vault: Vault;
  readonly entities: EntityService;
  readonly tasks: TaskService;
  readonly approvals: ApprovalService;
  readonly tools: ToolRuntime;
  readonly executor: Executor;
  readonly scheduler: Scheduler;
  readonly memory: MemoryService;
  readonly team: TeamService;
  readonly conversations: ConversationService;
  readonly memories: MemoryManagement;
  readonly questionDecisions: QuestionDecisions;
  readonly market: MarketService;
  readonly previews: ArtifactPreviews;
  private toolConnections: ToolConnections;
  private connectionRequests: CoreConnections;
  private artifactRequests: ArtifactRequests;
  private teamRequests: TeamRequests;
  private historyRequests: HistoryRequests;
  private backup: BackupService;
  private registry = createToolRegistry();
  private adapters: ProviderAdapter[];
  private maintenance = false;
  private admission: MaintenanceAdmission;
  constructor(
    dataDirectory: string,
    cipher?: CipherHost,
    private host?: HostRequest,
    adapters?: ProviderAdapter[],
  ) {
    this.state = new State(dataDirectory);
    const s = this.state.storage;
    this.vault = new Vault(join(dataDirectory, 'credentials.enc.json'), cipher);
    this.adapters = adapters ?? [
      ...createNativeAdapters(),
      new ChatGptAdapter(),
      new CustomApiAdapter(),
    ];
    this.entities = new EntityService(this.state, this.vault);
    this.tasks = new TaskService(this.state);
    this.team = new TeamService(this.state, this.entities);
    this.approvals = new ApprovalService(this.state);
    this.memory = new MemoryService(createStorageMemoryStore(s));
    this.memories = new MemoryManagement(this.state, this.memory, this.tasks);
    const context = new ContextManager({
      getCheckpoint: (bindingId) =>
        s.byField<ContextCheckpoint>('context_checkpoints', 'bindingId', bindingId).at(-1),
      saveCheckpoint: (cp) => s.put('context_checkpoints', cp),
      recordCompaction: (record) => {
        s.put('compactions', record);
        this.state.changed();
      },
    });
    this.tools = new ToolRuntime(
      this.state,
      this.registry,
      this.tasks,
      this.approvals,
      this.memory,
      this.team,
      this.memories,
    );
    this.executor = new Executor(
      this.state,
      this.tasks,
      this.tools,
      this.memory,
      context,
      this.vault,
      this.adapters,
    );
    this.scheduler = new Scheduler(this.state, this.tasks, this.executor, this.adapters);
    this.tools.controls = new TaskControlService(this.state, this.tasks, this.scheduler);
    this.questionDecisions = new QuestionDecisions(this.state, this.tasks);
    this.conversations = new ConversationService(this.state, this.tasks, this.scheduler);
    this.connectionRequests = new CoreConnections(
      this.state,
      this.vault,
      this.scheduler,
      this.adapters,
      this.entities,
    );
    this.teamRequests = new TeamRequests(
      this.state,
      this.entities,
      this.team,
      this.scheduler,
      this.connectionRequests,
    );
    this.toolConnections = new ToolConnections(
      this.state,
      this.entities,
      this.vault,
      this.registry,
    );
    this.backup = new BackupService(this.state);
    this.market = new MarketService(this.state, this.entities);
    this.previews = new ArtifactPreviews(this.state);
    this.artifactRequests = new ArtifactRequests(this.state, this.previews, this.host);
    this.historyRequests = new HistoryRequests(this.state);
    this.admission = new MaintenanceAdmission(
      this.state,
      this.tasks,
      this.scheduler,
      this.tools.processes,
    );
  }
  async start() {
    await this.vault.load();
    this.tools.processes.recover();
    this.scheduler.start();
    this.memories.start();
    this.questionDecisions.start();
    this.state.artifactContents.start(
      () => !this.maintenance && !this.scheduler.hasActive(),
      () => this.state.changed('content'),
    );
  }
  async close() {
    await this.state.artifactContents.close();
    this.connectionRequests.closeLogins();
    await this.toolConnections.close();
    this.questionDecisions.close();
    this.memories.close();
    this.connectionRequests.closeOAuth();
    await this.market.quiesce();
    await this.previews.close();
    await this.scheduler.close();
    await this.tools.processes.close();
    await this.registry.close();
    await this.vault.flush();
    this.vault.clear();
    this.state.storage.close();
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'system.prepareUpdate' || method === 'system.prepareDataDirectoryChange') {
      if (this.maintenance) throw new Error('正在处理备份，请稍后再试');
      return this.admission.prepare(
        method === 'system.prepareUpdate' ? 'update' : 'data-directory',
      );
    }
    if (method === 'system.releaseUpdate' || method === 'system.releaseDataDirectoryChange') {
      this.admission.release(method === 'system.releaseUpdate' ? 'update' : 'data-directory');
      return { released: true };
    }
    return this.admission.request(method, () => this.handleRequest(method, params));
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.maintenance && method !== 'state.snapshot')
      throw new Error('正在恢复备份，请稍后操作');
    if (method.startsWith('market.') || method === 'career.save') {
      if (method === 'market.import' && !params.path) {
        if (!this.host) throw new Error('导入预设需要桌面文件选择器或本地文件路径');
        const selection = (await this.host('chooseFile')) as { path?: string } | string | null;
        const path = typeof selection === 'string' ? selection : selection?.path;
        if (!path) return { cancelled: true };
        params = { ...params, path };
      }
      return this.market.request(method, params);
    }
    if (method === 'conversations.attach' || method === 'conversations.attachBytes') {
      return this.artifactRequests.request(method, params);
    }
    if (method === 'conversations.messages' || method === 'conversations.read') {
      return this.historyRequests.request(method, params);
    }
    switch (method.split('.')[0]) {
      case 'connections':
        return this.connectionRequests.request(method, params);
      case 'artifacts':
        return this.artifactRequests.request(method, params);
      case 'state':
      case 'messages':
      case 'runs':
        return this.historyRequests.request(method, params);
      case 'bots':
      case 'chief':
        return this.teamRequests.request(method, params);
      case 'conversations':
        return this.handleConversationRequest(method, params);
      case 'tasks':
      case 'questions':
      case 'approvals':
      case 'processes':
        return this.handleTaskRequest(method, params);
      case 'memories':
        return this.handleMemoryRequest(method, params);
      case 'workspaces':
      case 'tools':
      case 'skills':
        return this.handleResourceRequest(method, params);
      case 'backup':
        return this.handleBackupRequest(method, params);
    }
    return this.handleApplicationRequest(method, params);
  }

  private async handleApplicationRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const s = this.state.storage;
    switch (method) {
      case 'onboarding.skip':
        return skipOnboarding(this.state);
      case 'onboarding.complete':
        return completeOnboarding(this.state, this.team, params.input);
      case 'settings.save': {
        const input = z
          .object({
            maxActiveRuns: z.number().int().min(1).max(15),
            maxChildren: z.number().int().min(1).max(30),
            maxCoordinationRounds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            autoAnswerMemberQuestions: z.boolean(),
            trayEnabled: z.boolean(),
            userAvatar: avatarSchema,
            defaultSearchConnectionId: z
              .string()
              .nullable()
              .transform((value) => value ?? undefined),
          })
          .partial()
          .parse(params.input);
        if (input.defaultSearchConnectionId)
          required(s.get('tool_connections', input.defaultSearchConnectionId), '搜索连接不存在');
        s.setMetadata('settings', { ...this.state.settings(), ...input });
        if (input.autoAnswerMemberQuestions === false)
          for (const task of s
            .all<Task>('tasks')
            .filter((item) => item.kind === 'question-decision' && !terminal(item.status)))
            await this.scheduler.cancel(task.id);
        break;
      }
      case 'avatars.import': {
        if (!this.host) throw new Error('上传头像需要桌面图片选择器');
        return this.host('chooseAvatar');
      }
      case 'dialogs.chooseDirectory':
        return this.host ? this.host('chooseDirectory') : { path: undefined };
      case 'dialogs.chooseFile':
        return this.host ? this.host('chooseFile') : { path: undefined };
      default:
        throw new Error('不支持的应用操作');
    }
    this.state.changed();
    return { ok: true };
  }

  private async handleConversationRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'conversations.create':
        return this.entities.createConversation(params);
      case 'conversations.rename':
        return this.conversations.rename(objectId(), z.string().parse(params.name));
      case 'conversations.compact':
        return queueContextCompaction(this.state, this.tasks, objectId());
      case 'conversations.archive':
        return this.conversations.archive(objectId(), z.boolean().parse(params.archived));
      case 'conversations.delete':
        return this.conversations.delete(objectId());
      case 'conversations.members.update':
        return this.conversations.updateMembers(
          objectId(),
          z.array(z.string()).max(50).parse(params.memberIds),
        );
      case 'conversations.send':
        return this.tasks.send(
          z
            .object({
              conversationId: z.string(),
              content: z.string().max(100000),
              targetBotIds: z.array(z.string()).optional(),
              artifactIds: z.array(z.string()).optional(),
              requestId: z.string().optional(),
            })
            .parse(params),
        );
      default:
        throw new Error('不支持的应用操作');
    }
  }

  private async handleTaskRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
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
        await this.scheduler.cancel(question.taskId);
        this.tools.questions.cancelTask(question.taskId);
        return { cancelled: true };
      }
      case 'tasks.cancel':
        return this.scheduler.cancel(objectId());
      case 'tasks.inspect':
        return inspectTask(this.state, required(s.get<Task>('tasks', objectId()), '任务不存在'));
      case 'tasks.retry':
        return this.tasks.retry(objectId());
      case 'tasks.reconcile':
        return this.tools.controls!.reconcile(
          objectId(),
          z.enum(['succeeded', 'not_executed']).parse(params.outcome),
        );
      case 'approvals.resolve':
        this.approvals.resolve(objectId(), z.boolean().parse(params.approved));
        break;
      case 'processes.output':
        return required(this.tools.processes.output(objectId()), '命令记录不存在');
      default:
        throw new Error('不支持的应用操作');
    }
    this.state.changed();
    return { ok: true };
  }

  private async handleMemoryRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'memories.propose':
        return this.memories.propose(params);
      case 'memories.save':
        return this.memories.save(params, { kind: 'user' });
      case 'memories.pin':
        return this.memories.pin(objectId(), z.boolean().parse(params.pinned));
      case 'memories.merge':
        return this.memories.merge(params, { kind: 'user' });
      case 'memories.history':
        return this.memories.history(objectId());
      case 'memories.consolidate':
        return this.memories.consolidate(
          z
            .object({
              scope: z.enum(['bot', 'team', 'shared']).optional(),
              ownerId: z.string().optional(),
            })
            .parse(params),
        );
      case 'memories.resolve':
        this.memory.resolve(objectId(), z.boolean().parse(params.approved));
        break;
      case 'memories.revoke':
        return this.memories.revoke(objectId(), { kind: 'user' });
      default:
        throw new Error('不支持的应用操作');
    }
    this.state.changed();
    return { ok: true };
  }

  private async handleResourceRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'workspaces.add':
        return this.entities.addWorkspace(params);
      case 'tools.save':
        return this.toolConnections.save(params.input);
      case 'tools.probe':
        return this.toolConnections.probe(objectId());
      case 'tools.delete':
        await this.toolConnections.delete(objectId());
        break;
      case 'skills.import':
        return this.entities.importSkill(z.string().parse(params.path));
      case 'skills.delete': {
        if (s.get<{ bundled?: boolean }>('skills', objectId())?.bundled)
          throw new Error('内置 Office 技能由应用提供');
        if (
          s.all<Bot>('bots').some((bot) => bot.skillIds.includes(objectId())) ||
          s
            .all<PresetInstallation>('preset_installations')
            .some((item) => item.skillIds.includes(objectId()))
        )
          throw new Error('技能仍被成员或预设引用，请先解除引用');
        s.delete('skills', objectId());
        break;
      }
      default:
        throw new Error('不支持的应用操作');
    }
    this.state.changed();
    return { ok: true };
  }

  private async handleBackupRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const s = this.state.storage;
    switch (method) {
      case 'backup.create': {
        this.maintenance = true;
        await this.market.quiesce();
        try {
          return await this.backup.create();
        } finally {
          this.market.resume();
          this.maintenance = false;
        }
      }
      case 'backup.restore': {
        if (this.scheduler.hasActive()) throw new Error('请先停止所有运行，再恢复备份');
        this.maintenance = true;
        this.scheduler.pause();
        await this.market.quiesce();
        try {
          const result = await this.backup.restore(z.string().parse(params.path));
          migrateProviders(s);
          migrateContextSettings(s);
          ensureMemoryContentHashes(s);
          migrateReplyArtifacts(s);
          this.state.syncMainTeam();
          syncOfficeSkills(this.state);
          return result;
        } finally {
          this.market.resume();
          this.scheduler.resume(true);
          this.maintenance = false;
          this.state.changed();
        }
      }
      default:
        throw new Error('不支持的应用操作');
    }
  }
}
