import { createHash } from 'node:crypto';
import type {
  Artifact,
  Bot,
  Connection,
  Conversation,
  MemoryEntry,
  Run,
  Task,
  ToolConnection,
  Workspace,
} from '../domain/types.js';
import type { TaskGroupInput, ToolExecutionContext } from '../domain/tools.js';
import type { MemoryService } from '../runtime/memory.js';
import type { ApprovalService } from './approvals.js';
import type { TaskService } from './tasks.js';
import type { State } from './state.js';
import type { TeamService } from './team.js';
import type { MemoryManagement } from './memories.js';
import { accessibleArtifacts, messageTools, ownsTaskFile } from './tool-access.js';
import type { ProcessService } from './processes.js';
import type { QuestionService } from './questions.js';
import { authorizedSkills } from './skills.js';
import { inspectTask } from './task-inspection.js';
import { enabledQoderServices } from '../domain/qoder-services.js';
import { scanQoderSecurity } from './qoder-security-scan.js';
import type { TaskPlanService } from './task-plans.js';
import { scopedTask, returnTaskArtifacts } from './task-access.js';
import { artifactRequirement } from './task-requirements.js';
import type { TaskControlService } from './task-control.js';
import { assertUserMemorySources } from './memory-policy.js';
import { registerTaskArtifact } from './artifact-registration.js';

export class ToolContextFactory {
  private observations = new Map<string, Map<string, string>>();

  constructor(
    private state: State,
    private tasks: TaskService,
    private approvals: ApprovalService,
    private memory: MemoryService,
    private team: TeamService,
    private memoryManagement: MemoryManagement,
    private processes: ProcessService,
    private questions: QuestionService,
    private plans: TaskPlanService,
  ) {}

  release(runId: string) {
    this.observations.delete(runId);
  }

  create(
    run: Run,
    task: Task,
    bot: Bot,
    room: Conversation,
    workspace: Workspace,
    signal: AbortSignal,
    controls?: TaskControlService,
  ): ToolExecutionContext {
    const s = this.state.storage;
    const context: ToolExecutionContext = {
      runId: run.id,
      task,
      botId: bot.id,
      conversation: room,
      workspace,
      signal,
      requestApproval: (name, summary, args) =>
        this.approvals.request(run, name, summary, args, signal),
      listArtifacts: () =>
        accessibleArtifacts(this.state, room, bot.id, s.get<Task>('tasks', task.id) ?? task).map(
          (artifact) => artifactRequirement(s, artifact),
        ),
      findArtifact: (artifactId) => {
        const artifact = accessibleArtifacts(
          this.state,
          room,
          bot.id,
          s.get<Task>('tasks', task.id) ?? task,
        ).find((artifact) => artifact.id === artifactId);
        return artifact && artifactRequirement(s, artifact);
      },
      readArtifact: async (artifactId) => {
        signal.throwIfAborted();
        const currentBot = s.get<Bot>('bots', bot.id);
        if (!currentBot || currentBot.archived || !currentBot.toolNames.includes('read_artifact'))
          throw new Error('资料不存在或未授权');
        const currentRoom = s.get<Conversation>('conversations', room.id);
        const artifact =
          currentRoom &&
          accessibleArtifacts(
            this.state,
            currentRoom,
            bot.id,
            s.get<Task>('tasks', task.id) ?? task,
          ).find((item) => item.id === artifactId);
        if (!artifact) throw new Error('资料不存在或未授权');
        return this.state.artifactContents.read(artifact);
      },
      ...messageTools(this.state, room.id),
      getObservedFileVersion: (path) => this.observations.get(run.id)?.get(path),
      observeFile: (path, version) => {
        const files = this.observations.get(run.id) ?? new Map<string, string>();
        files.set(path, version);
        this.observations.set(run.id, files);
      },
      ownsFile: (path, version) => ownsTaskFile(this.state, task, path, version),
      ...(!task.kind
        ? {
            askUser: (input: Parameters<QuestionService['create']>[0]) => {
              if (this.processes.hasActiveRun(run.id))
                throw new Error('请先完成或停止本任务的活跃命令');
              return this.questions.create(input, context);
            },
          }
        : {}),
      registerArtifact: (input) => {
        return registerTaskArtifact(this.state, input, task, bot, room, run);
      },
      postMessage: (content, artifacts, conversationId) =>
        this.tasks.post(room.id, bot.id, run.id, content, artifacts, conversationId).id,
      delegateTask: (botId, goal, expectedOutput, dependencyIds, artifactIds, planStepId) =>
        this.tasks.create({
          botId,
          goal,
          expectedOutput,
          parentId: task.id,
          conversationId: room.id,
          dependencyIds,
          inputArtifactIds: artifactIds ?? s.get<Task>('tasks', task.id)?.inputArtifactIds,
          planStepId,
          requestId: createHash('sha256')
            .update(
              JSON.stringify({
                parentId: task.id,
                botId,
                goal,
                expectedOutput,
                planStepId,
                artifacts: [
                  ...(artifactIds ?? s.get<Task>('tasks', task.id)?.inputArtifactIds ?? []),
                ].sort(),
                dependencies: [...(dependencyIds ?? [])].sort(),
              }),
            )
            .digest('hex'),
        }),
      getTask: (taskId) => {
        const target = scopedTask(this.state, room, bot.id, taskId);
        if (!target) return undefined;
        const inspected = inspectTask(this.state, target);
        returnTaskArtifacts(this.state, room, bot.id, target, inspected.artifactIds);
        return inspected;
      },
      ...(bot.id === this.state.settings().mainBotId && room.chiefId === bot.id
        ? {
            listBots: () => this.team.catalog(),
            configureBot: (input: Record<string, unknown>) => this.team.configureMember(input),
            ...(!task.kind
              ? {
                  setTaskPlan: (input) => this.plans.set(task, input),
                  getTaskPlan: () => this.plans.get(task),
                  updatePlanStep: (input) => this.plans.update(task, input),
                }
              : {}),
            ...(room.purpose === 'chief' && room.kind === 'private'
              ? {
                  createTaskGroup: (input: TaskGroupInput) =>
                    this.team.createTaskGroup(task, input),
                }
              : {}),
          }
        : {}),
      recallMemory: (input) =>
        bot.memoryMode === 'off'
          ? []
          : this.memory.query({ botId: bot.id, conversationId: room.id }, input, {
              recordActiveRead: !task.kind,
              scopeKey: run.id,
            }),
      ...(bot.memoryMode !== 'off'
        ? {
            manageMemory: (input: Record<string, unknown>) =>
              this.memoryManagement.manage(input, bot.id, room.id, task),
          }
        : {}),
      proposeMemory: (content, scope, sourceIds, metadata) => {
        if (bot.memoryMode === 'off') throw new Error('当前智能体已关闭记忆');
        if (scope === 'shared') throw new Error('请先保存当前会话记忆，再由管家设置共享范围');
        assertUserMemorySources(this.state, sourceIds, [room.id]);
        const memory = this.memory.propose({
          botId: bot.id,
          conversationId: room.id,
          content,
          scope,
          sourceIds,
          ...metadata,
        });
        if (scope === 'bot' || bot.id === this.state.settings().mainBotId)
          return this.memoryManagement.manage(
            { action: 'approve', id: memory.id },
            bot.id,
            room.id,
            task,
          ) as MemoryEntry;
        this.state.changed();
        return memory;
      },
      getSecret: async () => {
        throw new Error('工具凭据服务尚未绑定');
      },
      defaultSearchConnectionId: this.state.settings().defaultSearchConnectionId,
      toolConnections: s
        .all<ToolConnection>('tool_connections')
        .filter((item) => item.enabled && bot.toolConnectionIds?.includes(item.id)),
      skills: authorizedSkills(this.state, bot),
    };
    context.processes = this.processes.forContext(context);
    Object.assign(context, controls?.forContext(context));
    if (
      !task.kind &&
      s.get<Connection>('connections', bot.connectionId)?.provider === 'qoder' &&
      enabledQoderServices(bot).includes('SecurityScan')
    )
      context.scanCodeSecurity = (input) =>
        scanQoderSecurity(input, context, this.state, this.processes);
    return context;
  }
}
