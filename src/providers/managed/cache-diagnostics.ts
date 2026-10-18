import { createHash } from 'node:crypto';
import type { Response, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { RunContext } from '../../domain/provider.js';

type Fingerprints = { instructions: string; tools: string; settings: string; input: string; items: string[] };
type Baseline = { requestId: string; responseId: string; fingerprints: Fingerprints };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

function fingerprints(body: ResponseCreateParamsStreaming): Fingerprints {
  const { instructions, tools, input, prompt_cache_options: _diagnostics, ...settings } = body;
  return { instructions: hash(instructions), tools: hash(tools), settings: hash(settings), input: hash(input),
    items: (Array.isArray(input) ? input : [input]).map(hash) };
}

function supportsComparison(context: RunContext): boolean {
  if (context.connection.provider !== 'chatgpt') return false;
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(context.bot.model);
  return !!match && (Number(match[1]) >= 6 || Number(match[1]) === 5 && Number(match[2]) >= 6);
}

/** Each run owns its baseline; only completed requests advance the comparison. */
export class ResponsesCacheDiagnostics {
  private baseline?: Baseline;

  begin(context: RunContext, requestId: string, body: ResponseCreateParamsStreaming) {
    const current = fingerprints(body), previous = this.baseline;
    let sharedInputItems = 0;
    if (previous) while (sharedInputItems < previous.fingerprints.items.length
      && current.items[sharedInputItems] === previous.fingerprints.items[sharedInputItems]) sharedInputItems++;
    const changedFields = previous ? (['instructions', 'tools', 'settings'] as const)
      .filter(key => current[key] !== previous.fingerprints[key]) : [];
    const comparisonResponseId = previous && supportsComparison(context) ? previous.responseId : undefined;
    context.emit({ type: 'status', data: { phase: 'model-cache-request', requestId,
      fingerprints: { instructions: current.instructions, tools: current.tools, settings: current.settings, input: current.input },
      inputItems: current.items.length,
      ...(previous ? { baselineRequestId: previous.requestId, baselineInputItems: previous.fingerprints.items.length,
        sharedInputItems, changedFields, inputPrefixUnchanged: sharedInputItems === previous.fingerprints.items.length } : {}),
      ...(comparisonResponseId ? { comparisonResponseId } : {}),
    } });
    return {
      options: comparisonResponseId ? { prompt_cache_options: { comparison_response_id: comparisonResponseId } } : {},
      complete: (response: Response) => {
        const diagnostics = response.prompt_cache_diagnostics;
        const details = response.usage?.input_tokens_details;
        context.emit({ type: 'status', data: { phase: 'model-cache-response', requestId, responseId: response.id,
          model: response.model, serviceTier: response.service_tier,
          ...(response.usage ? { inputTokens: response.usage.input_tokens } : {}),
          ...(details?.cached_tokens !== undefined ? { cachedInputTokens: details.cached_tokens } : {}),
          ...(details?.cache_write_tokens !== undefined ? { cacheWriteTokens: details.cache_write_tokens } : {}),
          diagnostics: diagnostics ? { type: diagnostics.type, ...(diagnostics.type === 'cache_miss' ? {
            reason: diagnostics.reason, cacheMissedTokens: diagnostics.cache_missed_tokens,
            comparisonReusableTokens: diagnostics.comparison_reusable_tokens,
          } : {}) } : { type: 'not_reported' },
        } });
        this.baseline = { requestId, responseId: response.id, fingerprints: current };
      },
    };
  }
}
