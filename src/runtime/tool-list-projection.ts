import type { ModelMessage } from '../domain/provider.js';
import type { Protocol } from '../domain/types.js';
import { estimateModelMessageTokens } from './model-history.js';

type Result = Record<string, unknown>;
const listTools = new Set(['list_directory', 'find_files', 'search_text', 'search_messages', 'list_artifacts']);
const paginationKeys = new Set(['offset', 'nextOffset', 'cursor', 'nextCursor', 'hasMore', 'pagination']);
const metadataKeys = new Set(['path', 'total', 'totalLength', 'status', 'isError', 'error', 'errorCode', 'code',
  'version', 'previousVersion', 'fileVersion', 'requirementVersion', 'query', 'pattern', 'glob', 'regex', 'contextLines', 'filters']);

/** The reference contains the original JSON, so list positions must never become text offsets. */
export function projectListToolResult(message: ModelMessage, reference: { id: string }, tokenBudget: number,
  protocol: Protocol = 'responses', toolName: string): ModelMessage | undefined {
  if (message.role !== 'tool' || !listTools.has(toolName) || message.providerItems?.length) return;
  const parsed = parseList(message.content, toolName);
  if (!parsed || !parsed.items.length || estimateModelMessageTokens(message, protocol) <= tokenBudget) return;
  const { items, metadata, pagination } = parsed;
  const project = (count: number): ModelMessage => ({ ...message,
    contextArtifactIds: [...new Set([...message.contextArtifactIds ?? [], reference.id])],
    content: JSON.stringify({ ...metadata, items: items.slice(0, count), previewOnly: true,
      returnedItems: count, omittedItems: items.length - count,
      ...(Object.keys(pagination).length ? { originalPagination: pagination } : {}),
      fullResult: { tool: 'read_artifact', arguments: { artifactId: reference.id, offset: 0,
        limit: Math.max(1, Math.min(24000, Math.floor(tokenBudget / 2))) } } }),
  });
  if (estimateModelMessageTokens(project(0), protocol) > tokenBudget) return;
  let low = 0, high = items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateModelMessageTokens(project(middle), protocol) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  const result = project(low);
  return estimateModelMessageTokens(result, protocol) < estimateModelMessageTokens(message, protocol) ? result : undefined;
}

function parseList(content: string, toolName: string) {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return; }
  if (Array.isArray(value)) {
    if (toolName !== 'search_messages' || !value.every(item => knownItem(item, toolName))) return;
    return { items: value, metadata: {}, pagination: {} };
  }
  if (!record(value) || toolName === 'search_messages' || !Array.isArray(value.items)) return;
  if (value.isError === true || value.error || ['error', 'failed', 'cancelled'].includes(String(value.status))) return;
  if (!value.items.every(item => knownItem(item, toolName))) return;
  const metadata: Result = {}, pagination: Result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'items') continue;
    if (paginationKeys.has(key)) pagination[key] = item;
    else if (metadataKeys.has(key)) metadata[key] = item;
    else return;
  }
  return { items: value.items, metadata, pagination };
}

function record(value: unknown): value is Result {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function knownItem(item: unknown, toolName: string): boolean {
  if (!record(item)) return false;
  if (toolName === 'search_messages') return typeof item.messageId === 'string' && typeof item.sequence === 'number'
    && typeof item.excerpt === 'string';
  if (toolName === 'list_artifacts') return typeof item.id === 'string' && typeof item.name === 'string';
  if (typeof item.path !== 'string') return false;
  if (toolName === 'list_directory') return typeof item.name === 'string' && typeof item.type === 'string' && typeof item.size === 'number';
  if (toolName === 'search_text') return typeof item.line === 'number' && typeof item.text === 'string' && Array.isArray(item.context);
  return true;
}
