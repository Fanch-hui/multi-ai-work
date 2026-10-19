import Ajv from 'ajv';
import type { ToolConnection } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { ToolDefinition } from '../domain/provider.js';
import { BridgeMutations } from './mcp-bridge.js';
import { remoteToolAlias, type McpCatalogDiagnostic, type McpToolTarget } from './mcp-catalog.js';
import { McpSessionManager, type McpSession, type RemoteTool } from './mcp-sessions.js';

const schemaValidator = new Ajv({ strict: false, allErrors: true });

export class McpConnections {
  private bridge = new BridgeMutations();
  private aliases = new Map<string, McpToolTarget>();
  private catalogErrors = new Map<string, McpCatalogDiagnostic>();
  private sessions = new McpSessionManager(
    (connectionId) => this.clearCatalog(connectionId),
    () => {
      this.aliases.clear();
      this.catalogErrors.clear();
    },
  );

  probe(
    connection: ToolConnection,
    getSecret: ToolExecutionContext['getSecret'],
  ): Promise<string[]> {
    return this.sessions.probe(connection, getSecret);
  }

  async describe(connectionId: string, context: ToolExecutionContext): Promise<unknown> {
    const connection = this.authorized(connectionId, context);
    const session = await this.sessions.get(connection, context.getSecret);
    return session.tools;
  }

  async catalog(context: ToolExecutionContext): Promise<ToolDefinition[]> {
    const connections = context.toolConnections.filter(
      (item) => item.enabled && item.kind !== 'search',
    );
    const definitions = await Promise.all(
      connections.map(async (connection) => {
        try {
          const session = await this.sessions.get(connection, context.getSecret);
          if (session.closed || this.sessions.isClosing) return [];
          this.catalogErrors.delete(connection.id);
          connection.toolNames = session.tools.map((tool) => tool.name);
          return session.tools.map((tool) => {
            const name = remoteToolAlias(connection, tool.name);
            this.aliases.set(name, { connectionId: connection.id, toolName: tool.name });
            return {
              name,
              description: `${connection.name} · ${tool.name}${tool.description ? `\n${tool.description}` : ''}`,
              inputSchema: tool.inputSchema,
            };
          });
        } catch {
          if (this.sessions.isClosing) return [];
          this.catalogErrors.set(connection.id, {
            connectionId: connection.id,
            message: 'MCP 工具目录获取失败，请检测连接',
          });
          return [];
        }
      }),
    );
    return definitions.flat();
  }

  resolve(name: string, context: ToolExecutionContext): McpToolTarget | undefined {
    const target = this.aliases.get(name);
    return target &&
      context.toolConnections.some(
        (item) => item.id === target.connectionId && item.enabled && item.kind !== 'search',
      )
      ? target
      : undefined;
  }

  diagnostics(context: ToolExecutionContext): McpCatalogDiagnostic[] {
    return context.toolConnections.flatMap((connection) => {
      const error = connection.enabled && this.catalogErrors.get(connection.id);
      return error ? [error] : [];
    });
  }

  private authorized(id: string, context: ToolExecutionContext): ToolConnection {
    const connection = context.toolConnections.find(
      (item) => item.id === id && item.enabled && item.kind !== 'search',
    );
    if (!connection) throw new Error('MCP 连接未授权或未启用');
    return connection;
  }

  async call(
    connectionId: string,
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const connection = this.authorized(connectionId, context);
    const session = await this.sessions.get(connection, context.getSecret);
    const tool = session.tools.find((item) => item.name === name);
    if (!tool) throw new Error('MCP 工具不存在，请刷新工具目录');
    const readOnly = tool.annotations?.readOnlyHint === true;
    if (
      !readOnly &&
      !(await context.requestApproval('call_mcp', `${connection.name}：${name}`, {
        connectionId,
        toolName: name,
        arguments: args,
      }))
    )
      throw new Error('MCP 调用未获批准');
    if (connection.kind === 'bridge' && !readOnly)
      return this.bridgeCall(session, connection, tool, args, context);
    this.validate(tool, args);
    context.signal.throwIfAborted();
    context.assertAuthorized?.();
    if (!readOnly) context.markDispatched?.();
    return session.callTool(name, args, context.signal);
  }

  private validate(tool: RemoteTool, args: Record<string, unknown>): void {
    const validate = schemaValidator.compile(tool.inputSchema);
    if (!validate(args))
      throw new Error(`MCP 参数无效：${schemaValidator.errorsText(validate.errors)}`);
  }

  private bridgeCall(
    session: McpSession,
    connection: ToolConnection,
    tool: RemoteTool,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
    return this.bridge.call({
      connectionId: connection.id,
      toolName: tool.name,
      args,
      context,
      acceptsRequestId: !!properties?.client_request_id,
      validate: (remoteArgs) => this.validate(tool, remoteArgs),
      invoke: (remoteArgs) => session.callTool(tool.name, remoteArgs, context.signal),
    });
  }

  private clearCatalog(connectionId: string): void {
    for (const [name, target] of this.aliases)
      if (target.connectionId === connectionId) this.aliases.delete(name);
    this.catalogErrors.delete(connectionId);
  }

  remove(connectionId: string): Promise<void> {
    return this.sessions.remove(connectionId);
  }

  close(): Promise<void> {
    return this.sessions.close();
  }
}
