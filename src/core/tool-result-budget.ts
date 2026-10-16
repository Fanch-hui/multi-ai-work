import type { ModelMessage, RunContext } from '../domain/provider.js';
import { estimateModelMessageTokens, estimateModelMessagesTokens, estimateTokens } from '../runtime/model-history.js';
import { projectToolResult, toolResultBudgets } from '../runtime/tool-result-budget.js';
import type { ContextReferences } from './context-references.js';

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
      if (message.role === 'tool' && original > limit && limit > 0) {
        try {
          const call = calls.get(message.callId ?? '');
          const page = call?.name === 'read_artifact';
          const args = page ? JSON.parse(call.arguments) as { artifactId?: string; offset?: number } : undefined;
          const reference = page ? typeof args?.artifactId === 'string' ? await references.readableArtifact(args.artifactId) : undefined
            : await references.preserveToolOutput(message);
          if (reference) next = projectToolResult(message, { id: reference.id, ...(page ? { offset: args?.offset ?? 0 } : {}) }, limit, protocol, page);
        } catch { input.signal.throwIfAborted(); }
      }
      if (next) { projected[batchStart + index] = next; changed = true; }
      remaining = Math.max(0, remaining - (next ? estimateModelMessageTokens(next, protocol) : original));
    }
    return changed ? projected : undefined;
  };
}
