import type { ToolConnection } from './types.js';

export function httpSearchConfiguration(connection?: Pick<ToolConnection, 'searchBackend' | 'searchMethod' | 'searchQueryField'>) {
  const method = connection?.searchMethod ?? (connection?.searchBackend === 'deepseek' ? 'POST' : 'GET');
  return { method, queryField: connection?.searchQueryField ?? (method === 'POST' ? 'query' : 'q') };
}

export function toolConfiguration(connection: ToolConnection): string {
  const { name, kind, transport, url, command, args, secretRef, enabled, searchBackend, searchMethod, searchQueryField } = connection;
  return JSON.stringify({ name, kind, transport, url, command, args, secretRef, enabled, searchBackend, searchMethod, searchQueryField });
}
