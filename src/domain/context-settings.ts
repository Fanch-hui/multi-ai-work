import type { Connection, ModelInfo } from './types.js';

export const DEFAULT_COMPACTION_THRESHOLD = 85;
export const DEFAULT_CHATGPT_CONTEXT_WINDOW = 272000;

export function defaultContextWindow(
  provider?: Connection['provider'],
  model?: ModelInfo,
): number | undefined {
  return (
    model?.contextWindow ?? (provider === 'chatgpt' ? DEFAULT_CHATGPT_CONTEXT_WINDOW : undefined)
  );
}

export function managedContextBudget(
  contextWindow: number | undefined,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
  configuredReserve?: number,
) {
  const outputReserve =
    configuredReserve ??
    (contextWindow ? Math.ceil((contextWindow * (100 - compactionThreshold)) / 100) : 0);
  const availableTokens = contextWindow ? Math.max(0, contextWindow - outputReserve) : undefined;
  const triggerTokens =
    contextWindow && availableTokens !== undefined
      ? Math.min(availableTokens, Math.floor((contextWindow * compactionThreshold) / 100))
      : undefined;
  const effectiveCompactionThreshold =
    contextWindow && triggerTokens !== undefined
      ? (triggerTokens / contextWindow) * 100
      : undefined;
  return {
    contextWindow,
    outputReserve,
    availableTokens,
    compactionThreshold,
    triggerTokens,
    effectiveCompactionThreshold,
  };
}
