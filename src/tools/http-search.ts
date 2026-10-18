import type { ToolConnection } from '../domain/types.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import { publicRequest } from './web.js';
import { extractSearchResults } from './web-content.js';

export async function searchHttp(connection: ToolConnection, query: string, signal: AbortSignal,
  getSecret: ToolExecutionContext['getSecret']) {
  if (!connection.url) throw new Error('搜索连接缺少地址');
  const deepseek = connection.searchBackend === 'deepseek';
  if (deepseek && (!query.trim() || Array.from(query).length > 128))
    throw new Error('DeepSeek 搜索词须为 1～128 个字符，且不能全为空白');
  const secret = await getSecret(connection.secretRef);
  if (deepseek && !secret) throw new Error('请在搜索连接的凭据中填写 DeepSeek API Key');
  const url = new URL(connection.url);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (deepseek) headers['Content-Type'] = 'application/json';
  else url.searchParams.set('q', query);
  const result = await publicRequest(url.href, signal, headers, deepseek ? JSON.stringify({ query }) : undefined);
  const extracted = extractSearchResults(result.text);
  if (deepseek && (!extracted.results || typeof extracted.results !== 'object'
    || !Array.isArray((extracted.results as Record<string, unknown>).results)))
    throw new Error('DeepSeek 搜索接口未返回有效的 results 列表，请检查接口地址');
  return { query, connectionId: connection.id, service: connection.name, backend: deepseek ? 'deepseek' : 'http',
    source: result.url, fetchedAt: new Date().toISOString(), ...extracted };
}
