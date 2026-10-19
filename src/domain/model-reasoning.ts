import type { ModelInfo, ProviderKind } from './types.js';

const fallbackOptions = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function reasoningConfiguration(
  provider: ProviderKind | undefined,
  model?: ModelInfo,
): { options: string[]; fallback: boolean } {
  if (model?.reasoning !== undefined) return { options: [...model.reasoning], fallback: false };
  return provider === 'custom'
    ? { options: [...fallbackOptions], fallback: true }
    : { options: [], fallback: false };
}

export function isReasoningSupported(
  provider: ProviderKind | undefined,
  model: ModelInfo | undefined,
  effort: string,
): boolean {
  if (!effort) return true;
  if (model?.reasoning !== undefined) return model.reasoning.includes(effort);
  return provider === 'custom';
}
