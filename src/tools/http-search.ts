import type { ToolConnection } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { publicRequest } from './web.js';
import { extractSearchResults } from './web-content.js';
import { httpSearchConfiguration } from '../domain/tool-connection.js';

export async function searchHttp(
  connection: ToolConnection,
  query: string,
  signal: AbortSignal,
  getSecret: ToolExecutionContext['getSecret'],
) {
  if (!connection.url) throw new Error('搜索连接缺少地址');
  const { method, queryField } = httpSearchConfiguration(connection);
  const secret = await getSecret(connection.secretRef);
  const url = new URL(connection.url);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  else url.searchParams.set(queryField, query);
  const result = await publicRequest(
    url.href,
    signal,
    headers,
    method === 'POST' ? JSON.stringify({ [queryField]: query }) : undefined,
  );
  const extracted = extractSearchResults(result.text);
  return {
    query,
    connectionId: connection.id,
    service: connection.name,
    backend: 'http',
    source: result.url,
    fetchedAt: new Date().toISOString(),
    ...extracted,
  };
}
