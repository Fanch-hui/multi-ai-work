import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../src/domain/provider.js';

const simulation = vi.hoisted(() => ({
  cancellation: 'ignored' as 'ignored' | 'honored' | 'completed',
  marker: '',
}));
vi.mock('../src/providers/managed/index.js', () => {
  class Adapter {
    async probe() {
      return { models: [], capabilities: {} };
    }
    async run(context: RunContext) {
      if (context.prompt.startsWith('记住')) {
        simulation.marker = context.prompt.match(/memory_[a-f0-9]+/)![0];
        return { text: simulation.marker };
      }
      if (context.prompt.startsWith('回忆')) {
        const file = await context.executeTool(
          'read_file',
          { path: 'verification.txt' },
          'read-verification',
        );
        return { text: simulation.marker + JSON.stringify(file) };
      }
      if (simulation.cancellation !== 'completed')
        context.emit({ type: 'text', data: { text: '1' } });
      if (simulation.cancellation === 'honored') context.signal.throwIfAborted();
      return { text: '1' };
    }
  }
  return { ChatGptAdapter: Adapter, CustomApiAdapter: Adapter };
});

import { main } from '../src/verification/providers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('provider verification cancellation verdict', () => {
  it.each([
    ['ignored', 'failed', 1],
    ['honored', 'passed', 0],
    ['completed', 'unverified', 0],
  ] as const)('reports %s cancellation as %s', async (cancellation, status, exitCode) => {
    simulation.cancellation = cancellation;
    vi.stubEnv('AI_TEAM_VERIFICATION_TEST_TOKEN', '');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await main([
        '--provider',
        'custom',
        '--run',
        '--model',
        'local-test',
        '--auth-none',
        '--token-env',
        'AI_TEAM_VERIFICATION_TEST_TOKEN',
      ]),
    ).toBe(exitCode);
    const report = JSON.parse(output.mock.calls.at(-1)![0]);
    for (const name of ['probe', 'text', 'multiTurn', 'tool', 'resume'])
      expect(report.checks[name].status).toBe('passed');
    expect(report.checks.cancel.status).toBe(status);
  });
});
