import type { ModelMessage } from '../domain/provider.js';
import type { Protocol } from '../domain/types.js';
import { estimateModelMessageTokens } from './model-history.js';
import { projectToolResult } from './tool-result-budget.js';

export function artifactReadPages(content: string): Record<string, unknown>[] | undefined {
  try {
    const value = JSON.parse(content) as { reads?: unknown };
    return Array.isArray(value.reads) &&
      value.reads.length > 0 &&
      value.reads.length <= 4 &&
      value.reads.every((item) => item && typeof item === 'object' && !Array.isArray(item))
      ? value.reads
      : undefined;
  } catch {
    return;
  }
}

/** Every page retains its own source and character coordinates. */
export function projectArtifactReadBatch(
  message: ModelMessage,
  readableIds: ReadonlySet<string>,
  tokenBudget: number,
  protocol: Protocol = 'responses',
): ModelMessage | undefined {
  const pages = artifactReadPages(message.content);
  if (!pages || estimateModelMessageTokens(message, protocol) <= tokenBudget) return;
  const overhead = estimateModelMessageTokens(
    { ...message, providerItems: undefined, content: JSON.stringify({ reads: [] }) },
    protocol,
  );
  let remaining = Math.max(0, tokenBudget - overhead);
  let changed = false;
  const reads = pages.map((page, index) => {
    const source: ModelMessage = {
      role: 'tool',
      callId: message.callId,
      content: JSON.stringify(page),
    };
    const limit = Math.floor(remaining / (pages.length - index));
    let next = source;
    if (
      typeof page.artifactId === 'string' &&
      readableIds.has(page.artifactId) &&
      (typeof page.content === 'string' || typeof page.preview === 'string') &&
      !page.error &&
      estimateModelMessageTokens(source, protocol) > limit
    ) {
      const projected = page.truncated === true;
      next =
        projectToolResult(source, { id: page.artifactId }, limit, protocol, !projected) ?? source;
      if (next !== source && projected) {
        const value = JSON.parse(next.content);
        delete value.previewOmission;
        value.fullResult.arguments.offset =
          (page.fullResult as { arguments?: { offset?: number } } | undefined)?.arguments?.offset ??
          page.offset ??
          0;
        next = { ...next, content: JSON.stringify(value) };
      }
    }
    changed ||= next !== source;
    remaining = Math.max(0, remaining - estimateModelMessageTokens(next, protocol));
    return JSON.parse(next.content) as Record<string, unknown>;
  });
  const result = { ...message, providerItems: undefined, content: JSON.stringify({ reads }) };
  return changed && estimateModelMessageTokens(result, protocol) <= tokenBudget
    ? result
    : undefined;
}
