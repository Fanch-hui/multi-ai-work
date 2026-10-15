import type { Usage } from './types.js';

export function addUsage(first?: Usage, second?: Usage): Usage | undefined {
  if (!first) return second;
  if (!second) return first;
  const sum = (field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens') =>
    first[field] === undefined || second[field] === undefined ? undefined : first[field] + second[field];
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cachedInputTokens: sum('cachedInputTokens'),
    source: first.source === 'unknown' || second.source === 'unknown' ? 'unknown'
      : first.source === 'reported' && second.source === 'reported' ? 'reported' : 'estimated' };
}
