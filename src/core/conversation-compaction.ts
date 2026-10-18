import type { Bot, Connection, Conversation, Task } from '../domain/types.js';
import { defaultContextWindow } from '../domain/context-settings.js';
import { required } from './errors.js';
import type { State } from './state.js';
import { terminal, type TaskService } from './tasks.js';

export function queueContextCompaction(state: State, tasks: TaskService, conversationId: string): Task {
  const s = state.storage;
  const room = required(s.get<Conversation>('conversations', conversationId), '对话不存在');
  if (room.kind !== 'private') throw new Error('请在单智能体对话中压缩上下文');
  const bot = required(s.get<Bot>('bots', room.chiefId ?? room.memberIds[0]), '智能体不存在');
  const connection = required(s.get<Connection>('connections', bot.connectionId), '请先配置模型连接');
  if (!['chatgpt', 'custom'].includes(connection.provider)) throw new Error('此通道的上下文由原生运行时管理');
  if (connection.status !== 'ready') throw new Error('请先完成模型连接检测');
  if (!(bot.contextWindow ?? defaultContextWindow(connection.provider,
    connection.models.find(model => model.id === (room.model ?? bot.model))))) throw new Error('请先在成员配置中设置上下文窗口');
  const unfinished = s.byField<Task>('tasks', 'conversationId', room.id).filter(task => !terminal(task.status));
  const existing = unfinished.find(task => task.kind === 'context-compaction');
  if (existing) return existing;
  if (unfinished.some(task => !task.kind)) throw new Error('请等待当前对话任务结束后再压缩');
  if (s.messages(room.id).filter(message => message.status === 'committed' && message.authorType === 'user').length < 2)
    throw new Error('当前历史较少，继续对话后可压缩');
  return tasks.create({ conversationId: room.id, botId: bot.id, goal: '手动压缩上下文', kind: 'context-compaction' });
}
