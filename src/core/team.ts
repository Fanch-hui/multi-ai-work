import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Bot, Connection, Conversation, Task, Workspace } from '../domain/types.js';
import type { TaskGroupInput } from '../domain/tools.js';
import { EntityService } from './entities.js';
import { memberTools } from './chief.js';
import { required } from './errors.js';
import { State, id, now } from './state.js';
import { TaskService, terminal } from './tasks.js';
import { isChiefProvider } from '../domain/chief-provider.js';

const memberSchema = z.object({ id: z.string().optional(), name: z.string().optional(), role: z.string().optional(),
  instructions: z.string().optional(), connectionId: z.string().optional(), model: z.string().optional(),
  personalInstructions: z.string().max(20000).optional(),
  reasoning: z.string().optional(), contextWindow: z.number().optional(), compactionThreshold: z.number().min(10).max(95).optional() }).strict();
const groupSchema = z.object({ name: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(120000),
  memberIds: z.array(z.string()).min(1).max(50), expectedOutput: z.string().max(120000).optional(), workspaceId: z.string().optional(),
  artifactIds: z.array(z.string()).max(50).optional() }).strict();

export class TeamService {
  constructor(private state: State, private entities: EntityService) {}

  createChiefConversation(name = '新对话', options: { workspaceId?: string; model?: string; reasoning?: string } = {}): Conversation {
    const s = this.state.storage, settings = this.state.settings();
    const chief = required(s.get<Bot>('bots', settings.mainBotId!), '主智能体不存在');
    const previous = required(s.get<Conversation>('conversations', settings.mainConversationId!), '主会话不存在');
    const workspaceId = options.workspaceId ?? previous.workspaceId;
    required(s.get('workspaces', workspaceId), '工作目录不存在');
    const { model, reasoning } = this.conversationModel(chief, options, chief);
    const room: Conversation = { id: id(), name: z.string().trim().min(1).max(120).parse(name), kind: 'private',
      purpose: 'chief', chiefId: chief.id, memberIds: [chief.id], workspaceId, model, reasoning, createdAt: now() };
    s.transaction(() => { s.put('conversations', room); s.setMetadata('settings', { ...settings, mainConversationId: room.id }); });
    this.state.changed(); return room;
  }

  updateChiefConversation(conversationId: string, options: { model?: string; reasoning?: string }): Conversation {
    const s = this.state.storage;
    const room = required(s.get<Conversation>('conversations', conversationId), '对话不存在');
    if (room.purpose !== 'chief' || room.kind !== 'private' || room.chiefId !== this.state.settings().mainBotId)
      throw new Error('只能修改主管主对话的模型设置');
    if (room.archived) throw new Error('对话已归档');
    if (s.all<Task>('tasks').some(task => task.conversationId === room.id && task.kind !== 'memory-review' && !terminal(task.status)))
      throw new Error('请先停止当前工作，再修改对话设置');
    const chief = required(s.get<Bot>('bots', room.chiefId!), '主智能体不存在');
    const settings = this.conversationModel(chief, options, room.model ? room : chief);
    const updated = { ...room, ...settings };
    s.put('conversations', updated); this.state.changed(); return updated;
  }

  private conversationModel(chief: Bot, options: { model?: string; reasoning?: string }, defaults: { model?: string; reasoning?: string }) {
    const model = z.string().trim().min(1, '请选择主管模型').parse(options.model ?? defaults.model);
    const connection = required(this.state.storage.get<Connection>('connections', chief.connectionId), '请先配置主管连接');
    if (!isChiefProvider(connection.provider)) throw new Error('管家请选择 ChatGPT 或自定义 API 连接');
    if (connection.status !== 'ready') throw new Error('请先完成主管连接');
    const catalog = connection.models.find(item => item.id === model);
    if (connection.models.length && !catalog) throw new Error('当前连接不提供所选模型');
    const inherited = model === defaults.model && catalog?.reasoning?.includes(defaults.reasoning ?? '') ? defaults.reasoning : undefined;
    const reasoning = options.reasoning === undefined ? inherited : options.reasoning || undefined;
    if (reasoning && !catalog?.reasoning?.includes(reasoning)) throw new Error('所选模型不支持此推理强度');
    return { model, reasoning };
  }

  createTaskGroup(sourceTask: Task, input: TaskGroupInput): { conversation: Conversation; task: Task } {
    const s = this.state.storage, chiefId = this.state.settings().mainBotId!;
    const source = required(s.get<Task>('tasks', sourceTask.id), '来源任务不存在');
    const sourceRoom = required(s.get<Conversation>('conversations', source.conversationId), '来源主对话不存在');
    if (sourceRoom.archived) throw new Error('来源主对话已归档');
    if (source.botId !== chiefId || sourceRoom.kind !== 'private' || sourceRoom.purpose !== 'chief') throw new Error('只有主对话的主管可创建任务群');
    const fields = groupSchema.parse(input), members = [...new Set(fields.memberIds)].filter(botId => botId !== chiefId).sort();
    if (!members.length) throw new Error('请选择相关成员加入任务群');
    const workspaceId = fields.workspaceId ?? sourceRoom.workspaceId;
    required(s.get('workspaces', workspaceId), '工作目录不存在');
    for (const memberId of members) {
      const bot = required(s.get<Bot>('bots', memberId), '智能体不存在');
      if (bot.archived) throw new Error('智能体已归档');
    }
    const key = `task-group:${source.id}:${createHash('sha256').update(JSON.stringify({ ...fields, workspaceId, memberIds: members })).digest('hex')}`;
    const saved = s.metadata<{ conversationId: string; taskId: string }>(key);
    if (saved) return { conversation: required(s.get<Conversation>('conversations', saved.conversationId), '任务群不存在'),
      task: required(s.get<Task>('tasks', saved.taskId), '任务群任务不存在') };
    const result = s.transaction(() => {
      const conversation: Conversation = { id: id(), name: fields.name, kind: 'group', purpose: 'task', chiefId,
        memberIds: [chiefId, ...members], workspaceId, model: sourceRoom.model, reasoning: sourceRoom.reasoning,
        sourceConversationId: sourceRoom.id, sourceTaskId: source.id, createdAt: now() };
      s.put('conversations', conversation);
      const task = new TaskService(this.state).create({ conversationId: conversation.id, botId: chiefId,
        parentId: source.id, goal: fields.goal, expectedOutput: fields.expectedOutput, inputArtifactIds: fields.artifactIds ?? source.inputArtifactIds, requestId: key });
      s.setMetadata(key, { conversationId: conversation.id, taskId: task.id });
      return { conversation, task };
    });
    this.state.changed(); return result;
  }

  configureChief(input: unknown, workspaceId?: string): Bot {
    const current = required(this.state.storage.get<Bot>('bots', this.state.settings().mainBotId!), '主智能体不存在');
    if (workspaceId) required(this.state.storage.get('workspaces', workspaceId), '工作目录不存在');
    const fields = z.record(z.string(), z.unknown()).parse(input);
    const bot = this.entities.saveBot({ ...current, ...fields, id: current.id });
    if (workspaceId) {
      const room = required(this.state.storage.get<Conversation>('conversations', this.state.settings().mainConversationId!), '主会话不存在');
      this.state.storage.put('conversations', { ...room, workspaceId });
    }
    this.state.changed(); return bot;
  }

  catalog() {
    return { bots: this.state.storage.all<Bot>('bots').filter(bot => !bot.archived).map(bot => ({
      id: bot.id, name: bot.name, connectionId: bot.connectionId,
      ...(bot.id !== this.state.settings().mainBotId ? { role: bot.role, instructions: bot.instructions,
        personalInstructions: bot.personalInstructions, preset: bot.preset ? { id: bot.preset.presetId, version: bot.preset.version } : undefined } : {}),
      model: bot.model, reasoning: bot.reasoning, contextWindow: bot.contextWindow, compactionThreshold: bot.compactionThreshold,
      toolNames: bot.toolNames, approvalMode: bot.approvalMode,
      chief: bot.id === this.state.settings().mainBotId })),
    workspaces: this.state.storage.all<Workspace>('workspaces').map(workspace => ({ id: workspace.id, name: workspace.name, writable: workspace.writable })),
    connections: this.state.storage.all<Connection>('connections').map(connection => ({ id: connection.id,
      name: connection.name, provider: connection.provider, status: connection.status, models: connection.models })) };
  }

  configureMember(input: unknown): Bot {
    const fields = memberSchema.parse(input);
    if (fields.id === this.state.settings().mainBotId) throw new Error('主智能体的配置由用户在界面设置');
    const old = fields.id ? required(this.state.storage.get<Bot>('bots', fields.id), '智能体不存在') : undefined;
    const bot = this.entities.saveBot({ ...old, ...fields,
      role: fields.role ?? old?.role ?? '', instructions: fields.instructions ?? old?.instructions ?? '',
      model: fields.model ?? old?.model ?? '', toolNames: old?.toolNames ?? memberTools,
      skillIds: old?.skillIds ?? [], toolConnectionIds: old?.toolConnectionIds ?? [], memoryMode: old?.memoryMode ?? 'propose' });
    return bot;
  }
}
