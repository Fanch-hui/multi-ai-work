import { z } from 'zod';
import type { ToolRegistry } from '../domain/tools.js';
import { createBuiltins } from './builtins.js';
import { McpConnections } from './mcp.js';
import { searchHttp } from './http-search.js';
import { searchConnection, tavilySearchTool } from './search.js';
import type { ToolDefinition } from '../domain/provider.js';

function freezeSchema<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) freezeSchema(item);
  return value;
}

export function createToolRegistry(): ToolRegistry {
  const mcp = new McpConnections();
  const builtins = createBuiltins(mcp);
  const builtinCatalog = Object.entries(builtins).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: freezeSchema(z.toJSONSchema(tool.schema, { target: 'draft-7' })),
    available: tool.available,
  }));
  const catalogs = new Map<string, ToolDefinition[]>();
  return {
    async prepare(context) {
      catalogs.set(context.runId, await mcp.catalog(context));
      const errors = mcp.diagnostics(context);
      for (const connection of context.toolConnections.filter((item) => item.kind !== 'search')) {
        connection.error = errors.find((item) => item.connectionId === connection.id)?.message;
        connection.status = connection.error ? 'error' : 'ready';
        if (
          !connection.error &&
          connection.kind === 'mcp' &&
          tavilySearchTool(connection.toolNames)
        )
          connection.searchBackend = 'tavily';
      }
    },
    release(runId) {
      catalogs.delete(runId);
    },
    canonical(name, args, context) {
      const remote = mcp.resolve(name, context);
      if (remote) return { name: 'call_mcp', args: { ...remote, arguments: args } };
      if (name === 'search_web')
        return {
          name,
          args: {
            ...args,
            connectionId: searchConnection(context, args.connectionId as string | undefined).id,
          },
        };
      return { name, args };
    },
    definitions(context) {
      return [
        ...builtinCatalog
          .filter((tool) => !tool.available || tool.available(context))
          .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ...(catalogs.get(context.runId) ?? []).filter((tool) => !!mcp.resolve(tool.name, context)),
      ];
    },
    async execute(name, args, context) {
      context.signal.throwIfAborted();
      const tool = builtins[name];
      if (!tool || (tool.available && !tool.available(context)))
        throw new Error(`工具未授权或不可用：${name}`);
      const validated = tool.schema.strict().parse(args);
      return tool.execute(validated, context);
    },
    async probeConnection(connection, getSecret) {
      if (connection.kind !== 'search') return mcp.probe(connection, getSecret);
      await searchHttp(
        connection,
        'multi-AI work connectivity',
        AbortSignal.timeout(20_000),
        getSecret,
      );
      return ['search_web'];
    },
    removeConnection(connectionId) {
      return mcp.remove(connectionId);
    },
    close() {
      return mcp.close();
    },
  };
}
