import { describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';
import { qoderServiceOptions } from '../src/providers/native/qoder-services.js';

describe('Qoder 持久等待边界', () => {
  it('等待后阻止新原生工具及 App 工具执行', async () => {
    const authorize = vi.fn();
    const context = {
      signal: new AbortController().signal,
      tools: [{ name: 'read_file' }],
      nativeTools: { names: ['ImageGen'], authorize },
      isWaitingForInput: () => true,
    } as unknown as RunContext;
    const options = qoderServiceOptions(context);
    for (const name of ['ImageGen', 'mcp__ai-team__read_file']) {
      expect(
        await options.canUseTool!(
          name,
          {},
          {
            signal: context.signal,
            toolUseID: name,
          },
        ),
      ).toMatchObject({ behavior: 'deny', message: expect.stringContaining('此调用未执行') });
    }
    expect(authorize).not.toHaveBeenCalled();
  });
});
