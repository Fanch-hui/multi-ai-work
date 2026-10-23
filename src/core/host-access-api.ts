import { z } from 'zod';
import type { HostDevice, HostDeviceScope } from '../domain/host-access.js';
import type { Conversation, Message, Task } from '../domain/types.js';
import type { State } from './state.js';
import { terminal } from './tasks.js';

export type HostDispatch = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export class HostAccessApi {
  constructor(
    private state: State,
    private dispatch: HostDispatch,
  ) {}
  async request(device: HostDevice, method: string, path: string, input: unknown) {
    if (method === 'GET' && path === '/conversations') {
      this.requireScope(device, 'read');
      return this.state.storage
        .all<Conversation>('conversations')
        .filter((room) => device.conversationIds.includes(room.id) && !room.archived)
        .map((room) => ({ id: room.id, name: room.name, kind: room.kind }));
    }
    const route = /^\/conversations\/([^/]+)\/(messages|tasks|stop)$/.exec(path);
    if (!route) throw new Error('不支持的宿主接口');
    const conversationId = decodeURIComponent(route[1]!);
    this.requireConversation(device, conversationId);
    if (method === 'GET' && route[2] === 'messages') {
      this.requireScope(device, 'read');
      const { before, limit } = z
        .object({
          before: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(input);
      const messages = this.state.storage
        .messages(conversationId)
        .filter((message) => message.authorType !== 'system' && message.status !== 'draft');
      const boundary = before
        ? messages.findIndex((message) => message.id === before)
        : messages.length;
      if (boundary < 0) throw new Error('消息游标不存在');
      const page = messages.slice(Math.max(0, boundary - limit), boundary);
      return {
        messages: page.map(this.publicMessage),
        hasMore: boundary > limit,
        before: page[0]?.id,
      };
    }
    if (method === 'GET' && route[2] === 'tasks') {
      this.requireScope(device, 'read');
      return this.state.storage
        .all<Task>('tasks')
        .filter((task) => task.conversationId === conversationId)
        .map((task) => ({
          id: task.id,
          goal: task.goal,
          botId: task.botId,
          status: task.status,
          active: !terminal(task.status),
        }));
    }
    if (method === 'POST' && route[2] === 'messages') {
      this.requireScope(device, 'send');
      const parsed = z
        .object({
          content: z.string().trim().min(1).max(100000),
          requestId: z.string().min(1).max(100),
        })
        .parse(input);
      return this.dispatch('conversations.send', {
        conversationId,
        content: parsed.content,
        requestId: `device:${device.id}:${parsed.requestId}`,
      });
    }
    if (method === 'POST' && route[2] === 'stop') {
      this.requireScope(device, 'stop');
      const { taskId } = z.object({ taskId: z.string() }).parse(input);
      const task = this.state.storage.get<Task>('tasks', taskId);
      if (!task || task.conversationId !== conversationId) throw new Error('任务不属于当前会话');
      return this.dispatch('tasks.cancel', { id: taskId });
    }
    throw new Error('不支持的宿主接口');
  }
  private requireScope(device: HostDevice, scope: HostDeviceScope) {
    if (!device.scopes.includes(scope)) throw new Error('设备未获准此项操作');
  }
  private requireConversation(device: HostDevice, id: string) {
    const room = this.state.storage.get<Conversation>('conversations', id);
    if (!device.conversationIds.includes(id) || !room || room.archived)
      throw new Error('设备未获准访问此会话');
  }
  private publicMessage(message: Message) {
    return {
      id: message.id,
      authorType: message.authorType,
      authorBotId: message.authorBotId,
      content: message.content,
      createdAt: message.createdAt,
      artifactIds: message.artifactIds,
    };
  }
}
