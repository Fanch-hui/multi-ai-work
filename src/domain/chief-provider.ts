import type { ProviderKind } from './types.js';

export function isChiefProvider(provider: ProviderKind): boolean {
  return provider === 'chatgpt' || provider === 'custom';
}
