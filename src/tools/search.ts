import type { ToolConnection } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { McpConnections } from './mcp.js';
import { searchWeb } from './web.js';
import { extractSearchResults } from './web-content.js';

export function tavilySearchTool(names: readonly string[]): string | undefined {
  return ['tavily-search', 'tavily_search'].find(name => names.includes(name));
}

export function isSearchConnection(connection: ToolConnection): boolean {
  return connection.enabled && (connection.kind === 'search'
    || connection.kind === 'mcp' && (connection.searchBackend === 'tavily' || !!tavilySearchTool(connection.toolNames)));
}

export function searchConnection(context: ToolExecutionContext, connectionId?: string): ToolConnection {
  const choices = context.toolConnections.filter(isSearchConnection);
  if (connectionId) {
    const selected = choices.find(item => item.id === connectionId);
    if (!selected) throw new Error('搜索连接未授权、未启用或尚未发现搜索工具');
    return selected;
  }
  const selected = choices.find(item => item.id === context.defaultSearchConnectionId);
  if (selected) return selected;
  if (choices.length === 1) return choices[0];
  if (!choices.length) throw new Error('尚未授权搜索服务，请在工具连接中配置并授权 HTTP 搜索或 Tavily MCP');
  throw new Error(`有多个可用搜索服务，请指定 connectionId 或设置默认服务：${choices.map(item => `${item.name} (${item.id})`).join('；')}`);
}

export async function search(query: string, connectionId: string | undefined, context: ToolExecutionContext, mcp: McpConnections) {
  const connection = searchConnection(context, connectionId);
  if (connection.kind === 'search') return searchWeb(query, connection.id, context);
  const toolName = tavilySearchTool(connection.toolNames);
  if (!toolName) throw new Error('Tavily 搜索工具尚未发现，请重新检测连接');
  const result = await mcp.call(connection.id, toolName, { query }, context) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  if (result.isError) throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '搜索服务调用失败');
  const raw = result.structuredContent === undefined
    ? result.content?.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n') ?? ''
    : JSON.stringify(result.structuredContent);
  return { query, connectionId: connection.id, service: connection.name, backend: 'tavily', fetchedAt: new Date().toISOString(), ...extractSearchResults(raw) };
}
