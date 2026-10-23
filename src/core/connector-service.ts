import { z } from 'zod';
import type { Bot, ToolConnection } from '../domain/types.js';
import type { ToolExecutionContext, ToolRegistry } from '../domain/tools.js';
import type { State } from './state.js';
import type { ToolConnections } from './tool-connections.js';
import type { TaskService } from './tasks.js';
import { ConnectorDrafts } from './connector-drafts.js';
import type { ConnectorOAuth } from './connector-oauth.js';

const objectId = z.string().trim().min(1).max(200);
export const connectorCatalog = [
  {
    id: 'mcp-http',
    name: '远程 MCP',
    description: '连接服务商提供的 MCP 地址，支持浏览器授权或 Bearer 凭据。',
    kind: 'mcp',
    transport: 'http',
    authentication: ['oauth', 'bearer', 'none'],
  },
  {
    id: 'mcp-stdio',
    name: '本机 MCP',
    description: '使用本机已安装的 MCP 服务程序，按成员授权工具。',
    kind: 'mcp',
    transport: 'stdio',
    authentication: ['environment'],
  },
  {
    id: 'http-search',
    name: 'HTTP 搜索',
    description: '配置真实搜索服务地址，使用 GET 或 POST 提交关键词。',
    kind: 'search',
    transport: 'http',
    authentication: ['bearer', 'none'],
  },
] as const;

export class ConnectorService {
  readonly drafts: ConnectorDrafts;
  constructor(
    private state: State,
    private connections: ToolConnections,
    tasks: TaskService,
    private registry: ToolRegistry,
    private oauth: ConnectorOAuth,
  ) {
    this.drafts = new ConnectorDrafts(state, tasks, registry);
    oauth.onAuthorized = (id) => connections.probe(id);
  }
  start() {
    this.drafts.recover();
  }
  close() {
    return this.oauth.close();
  }
  async prepareRestore() {
    await this.oauth.prepareRestore();
    await Promise.all(
      this.state.storage
        .all<ToolConnection>('tool_connections')
        .map((connection) => this.registry.removeConnection?.(connection.id)),
    );
  }
  finishRestore() {
    return this.oauth.finishRestore();
  }
  execute(
    action: 'create' | 'send' | 'get',
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    return this.drafts.execute(action, args, context);
  }
  async request(method: string, params: Record<string, unknown>) {
    if (method.startsWith('connectorDrafts.')) return this.drafts.request(method, params);
    if (method === 'connectors.catalog') return connectorCatalog;
    if (method === 'connectors.list') {
      const bots = this.state.storage.all<Bot>('bots').filter((bot) => !bot.archived);
      return Promise.all(
        this.state.storage.all<ToolConnection>('tool_connections').map(async (connection) => ({
          ...connection,
          secretRef: undefined,
          authenticated: !!connection.secretRef,
          authorizedBots: bots
            .filter((bot) => bot.toolConnectionIds?.includes(connection.id))
            .map(({ id, name }) => ({ id, name })),
          authentication: await this.oauth.status(connection.id),
        })),
      );
    }
    if (method === 'connectors.save') {
      const fields = z
        .object({
          id: objectId.optional(),
          kind: z.string(),
          transport: z.string().optional(),
          url: z.string().optional(),
          secret: z.string().optional(),
        })
        .passthrough()
        .parse(params.input);
      const previous =
        fields.id && this.state.storage.get<ToolConnection>('tool_connections', fields.id);
      if (
        previous &&
        (previous.url !== fields.url ||
          previous.kind !== fields.kind ||
          previous.transport !== fields.transport ||
          fields.secret)
      )
        await this.oauth.reset(previous.id);
      return this.connections.save(fields);
    }
    const id = objectId.parse(params.id);
    if (method === 'connectors.setAccess') {
      if (!this.state.storage.get('tool_connections', id)) throw new Error('连接器不存在');
      const botIds = z.array(objectId).max(100).parse(params.botIds);
      const bots = this.state.storage.all<Bot>('bots').filter((bot) => !bot.archived);
      if (botIds.some((botId) => !bots.some((bot) => bot.id === botId)))
        throw new Error('授权成员不存在');
      this.state.storage.db.transaction(() => {
        for (const bot of bots) {
          const before = bot.toolConnectionIds ?? [];
          const authorized = botIds.includes(bot.id);
          if (before.includes(id) === authorized) continue;
          this.state.storage.put('bots', {
            ...bot,
            toolConnectionIds: authorized
              ? [...before, id]
              : before.filter((value) => value !== id),
            revision: bot.revision + 1,
          });
        }
      })();
      this.state.changed();
      return { ok: true };
    }
    if (method === 'connectors.probe') return this.connections.probe(id);
    if (method === 'connectors.authStatus') return this.oauth.status(id);
    if (method === 'connectors.login') {
      await this.registry.removeConnection?.(id);
      return this.oauth.login(
        id,
        z.object({ clientId: objectId.optional(), issuer: z.url().optional() }).parse(params),
      );
    }
    if (method === 'connectors.logout') {
      const result = await this.oauth.logout(id);
      await this.registry.removeConnection?.(id);
      return result;
    }
    if (method === 'connectors.delete') {
      await this.oauth.reset(id);
      await this.connections.delete(id);
      return { ok: true };
    }
    throw new Error('未知连接器操作');
  }
}
