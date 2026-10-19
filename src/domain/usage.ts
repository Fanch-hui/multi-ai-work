import type { Usage } from './types.js';

export function addUsage(first?: Usage, second?: Usage): Usage | undefined {
  if (!first) return second;
  if (!second) return first;
  const sum = (field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens') =>
    first[field] === undefined || second[field] === undefined
      ? undefined
      : first[field] + second[field];
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const cachedInputTokens = sum('cachedInputTokens');
  let source: Usage['source'] = 'estimated';
  if (first.source === 'unknown' || second.source === 'unknown') source = 'unknown';
  else if (first.source === 'reported' && second.source === 'reported') source = 'reported';
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    source,
  };
}
