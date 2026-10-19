import type { ModelMessage } from '../domain/provider.js';
import type { Protocol } from '../domain/types.js';
import { estimateModelMessageTokens } from './model-history.js';

export interface ToolResultReference {
  id: string;
  offset?: number;
}
const metadataKeys =
  /^(?:status|isError|error|errorCode|code|exitCode|signal|path|workingPath|name|version|previousVersion|fileVersion|requirementVersion|sha256|artifactId|artifactIds|mimeType|size|offset|nextOffset|endLine|cursor|nextCursor|total|totalLength|totalLines|hasMore|pagination|superseded|contentAvailable)$/;

export function toolResultBudgets(inputBudget?: number) {
  return {
    single: Math.min(6000, Math.floor((inputBudget ?? 60000) * 0.1)),
    batch: Math.min(16000, Math.floor((inputBudget ?? 64000) * 0.25)),
  };
}

/** Only the model projection is reduced; the supplied reference must already be readable. */
export function projectToolResult(
  message: ModelMessage,
  reference: ToolResultReference,
  tokenBudget: number,
  protocol: Protocol = 'responses',
  artifactPage = false,
): ModelMessage | undefined {
  const parsed = parseResult(message.content);
  const page = artifactPage && parsed && typeof parsed.content === 'string';
  const source = page ? (parsed.content as string) : message.content;
  const metadata = parsed ? retainedMetadata(parsed) : {};
  const project = (characters: number): ModelMessage => {
    const head = safeHead(source, Math.ceil(characters / 2));
    const tail = safeTail(source, Math.floor(characters / 2));
    const offset =
      page && typeof parsed.offset === 'number' ? parsed.offset : (reference.offset ?? 0);
    return {
      ...message,
      providerItems: undefined,
      contextArtifactIds: [...new Set([...(message.contextArtifactIds ?? []), reference.id])],
      content: JSON.stringify({
        ...metadata,
        [page ? 'content' : 'preview']:
          `${head}\n[…中间内容已省略，请按完整结果引用读取…]\n${tail}`,
        truncated: true,
        previewOmission: {
          offset: offset + head.length,
          endOffset: offset + source.length - tail.length,
        },
        fullResult: {
          tool: 'read_artifact',
          arguments: {
            artifactId: reference.id,
            offset: offset + head.length,
            limit: Math.max(1, Math.min(24000, Math.floor(tokenBudget / 2))),
          },
        },
      }),
    };
  };
  if (estimateModelMessageTokens(project(0), protocol) > tokenBudget) return;
  let low = 0,
    high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateModelMessageTokens(project(middle), protocol) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  const result = project(low);
  return estimateModelMessageTokens(result, protocol) <
    estimateModelMessageTokens(message, protocol)
    ? result
    : undefined;
}

function parseResult(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return;
  }
}

function retainedMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      metadataKeys.test(key) ||
      /Ids?$/.test(key) ||
      item === null ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      (typeof item === 'string' && item.length <= 256)
    )
      result[key] = item;
    else if (Array.isArray(item)) {
      const nested = item.flatMap((child) => {
        if (!child || typeof child !== 'object' || Array.isArray(child)) return [];
        const metadata = retainedMetadata(child as Record<string, unknown>);
        return Object.keys(metadata).length ? [metadata] : [];
      });
      if (nested.length) result[key] = nested;
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = retainedMetadata(item as Record<string, unknown>);
      if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}

function safeHead(text: string, length: number): string {
  const end = length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1]) ? length - 1 : length;
  return text.slice(0, end);
}
function safeTail(text: string, length: number): string {
  let start = text.length - length;
  if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
  return text.slice(start);
}
