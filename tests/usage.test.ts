import { describe, expect, it } from 'vitest';
import { addUsage } from '../src/domain/usage.js';

describe('用量完整性', () => {
  it('每个桶只有所有调用都报告时才累计', () => {
    const total = addUsage(
      { inputTokens: 100, source: 'reported' },
      { inputTokens: 200, outputTokens: 20, cachedInputTokens: 0, source: 'reported' },
    );
    expect(total).toMatchObject({
      inputTokens: 300,
      outputTokens: undefined,
      cachedInputTokens: undefined,
      source: 'reported',
    });
  });
  it('未知调用不会成为零用量或估算', () => {
    expect(
      addUsage({ inputTokens: 100, outputTokens: 20, source: 'reported' }, { source: 'unknown' }),
    ).toMatchObject({ inputTokens: undefined, outputTokens: undefined, source: 'unknown' });
  });
  it('摘要估算与推理报告合并时保留来源，缓存不重复累加', () => {
    expect(
      addUsage(
        { inputTokens: 10, outputTokens: 2, source: 'estimated' },
        { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, source: 'reported' },
      ),
    ).toMatchObject({
      inputTokens: 110,
      outputTokens: 22,
      cachedInputTokens: undefined,
      source: 'estimated',
    });
  });
});
