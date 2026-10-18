import type { ModelMessage, RunContext } from '../domain/provider.js';
import { estimateModelMessageTokens, estimateModelMessagesTokens, estimateTokens } from '../runtime/model-history.js';
import { projectToolResult, toolResultBudgets } from '../runtime/tool-result-budget.js';
import type { ContextReferences } from './context-references.js';
import { artifactReadPages, projectArtifactReadBatch } from '../runtime/artifact-read-projection.js';
import type { Protocol } from '../domain/types.js';
import { projectListToolResult } from '../runtime/tool-list-projection.js';

export function prepareToolResultBudget(input: RunContext, references: ContextReferences | undefined,
  inputBudget?: number): NonNullable<RunContext['prepareToolResults']> {
  return async (messages, batchStart) => {
    if (!references) return;
    input.signal.throwIfAborted();
    const { single, batch } = toolResultBudgets(inputBudget);
    const protocol = input.connection.protocol;
    const results = messages.slice(batchStart);
    const fixed = estimateTokens(input.instructions) + estimateTokens(input.tools) + 256
      + estimateModelMessagesTokens(messages.slice(0, batchStart), protocol);
    let remaining = Math.min(batch, inputBudget === undefined ? batch : Math.max(0, inputBudget - fixed));
    const calls = new Map(messages.slice(0, batchStart).flatMap(message => message.toolCalls ?? []).map(call => [call.id, call]));
    const projected = [...messages];
    let changed = false;
    for (let index = 0; index < results.length; index++) {
      const message = results[index], original = estimateModelMessageTokens(message, protocol);
      const limit = Math.min(single, Math.floor(remaining / (results.length - index)));
      let next: ModelMessage | undefined;
      const call = calls.get(message.callId ?? '');
      if (message.role === 'tool' && call?.name === 'read_artifact') {
        try {
          const args = JSON.parse(call.arguments) as { reads?: { artifactId: string }[] };
          if (Array.isArray(args.reads)) next = await prepareArtifactBatch(message, args.reads, references, limit, protocol);
        } catch { input.signal.throwIfAborted(); }
      }
      if (!next && message.role === 'tool' && original > limit && limit > 0) {
        try {
          const page = call?.name === 'read_artifact';
          const args = page ? JSON.parse(call.arguments) as { artifactId?: string; offset?: number } : undefined;
          const reference = page ? typeof args?.artifactId === 'string' ? await references.readableArtifact(args.artifactId) : undefined
            : await references.preserveToolOutput(message);
          if (reference) {
            next = (!page && call ? projectListToolResult(message, reference, limit, protocol, call.name) : undefined)
              ?? projectToolResult(message, { id: reference.id, ...(page ? { offset: args?.offset ?? 0 } : {}) }, limit, protocol, page);
            if (next && !page && references.isProjection(message)) {
              const value = JSON.parse(next.content);
              delete value.previewOmission;
              value.fullResult.arguments.offset = 0;
              next = { ...next, content: JSON.stringify(value) };
            }
            if (next) references.registerProjection(next, reference);
          }
        } catch { input.signal.throwIfAborted(); }
      }
      if (next && next !== message) {
        projected[batchStart + index] = next; changed = true;
      }
      remaining = Math.max(0, remaining - (next ? estimateModelMessageTokens(next, protocol) : original));
    }
    return changed ? projected : undefined;
  };
}

async function prepareArtifactBatch(message: ModelMessage, reads: { artifactId: string }[], references: ContextReferences,
  limit: number, protocol?: Protocol): Promise<ModelMessage | undefined> {
  const pages = artifactReadPages(message.content);
  if (!pages) return;
  const requested = new Set(reads.map(read => read.artifactId));
  const ids = [...new Set(pages.flatMap(page => typeof page.artifactId === 'string' && requested.has(page.artifactId)
    && !page.error && page.contentAvailable !== false ? [page.artifactId] : []))];
  const sources = (await Promise.all(ids.map(id => references.readableArtifact(id)))).filter(source => source !== undefined);
  if (!sources.length) return;
  const result = projectArtifactReadBatch(message, new Set(sources.map(source => source.id)), limit, protocol) ?? message;
  const contextArtifactIds = [...new Set([...message.contextArtifactIds ?? [], ...sources.map(source => source.id)])];
  const projected = result === message && JSON.stringify(contextArtifactIds) === JSON.stringify(message.contextArtifactIds)
    ? message : { ...result, contextArtifactIds };
  references.registerProjection(projected, sources);
  return projected;
}
