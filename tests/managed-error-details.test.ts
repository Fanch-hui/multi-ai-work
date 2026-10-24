import { describe, expect, it, vi } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient, providerError } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';
import { isTransientModelError, modelErrorDetails } from '../src/providers/managed/retry.js';

const code = 'subscription_sharing_unsupported_capability';

describe('managed safe error details', () => {
  it.each([
    'input',
    'input[0].type',
    'tools[12].parameters.properties.title',
    'reasoning.effort',
    'prompt_cache_options.comparison_response_id',
    'service_tier',
  ])('preserves the bounded Responses parameter path %s', (param) => {
    expect(modelErrorDetails({ status: 400, code, param })).toEqual({ status: 400, code, param });
    expect(modelErrorDetails({ error: { code, param } })).toEqual({ code, param });
  });

  it.each([
    undefined,
    null,
    3,
    { field: 'input' },
    'unknown.field',
    'Bearer fixture-secret',
    'input.fixture-secret',
    'input["private content"]',
    'input.客户名称',
    'input\nmessage',
    'input[-1]',
    'input[1000000]',
    `input.${'x'.repeat(49)}`,
    `input${'.field'.repeat(9)}`,
    `input.${'field.'.repeat(27)}field`,
  ])('omits unsafe parameter shapes: %s', (param) => {
    expect(modelErrorDetails({ status: 400, code, param })).toEqual({ status: 400, code });
  });

  it('preserves safe details on the friendly provider error without copying server content', () => {
    const error = providerError({
      status: 400,
      error: { code, param: 'input[0].type', message: 'private fixture content' },
      body: 'private fixture body',
      headers: { authorization: 'private fixture header' },
    });
    expect(error).toMatchObject({ status: 400, code, param: 'input[0].type' });
    expect(error.message).toBe(`模型请求失败（HTTP 400，${code}）`);
    expect(Object.keys(error).sort()).toEqual(['code', 'param', 'status']);
    expect(isTransientModelError(error)).toBe(false);
  });

  it.each(['http', 'failed', 'error'])(
    'keeps rejected parameters through the %s request and diagnostic event without retrying',
    async (kind) => {
      const rejection = { code, param: 'input[0].type', message: 'private fixture content' };
      const fetcher = vi.fn(async () => {
        if (kind === 'http')
          return new Response(JSON.stringify({ error: rejection }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        const event =
          kind === 'failed'
            ? {
                type: 'response.failed',
                response: { id: 'response', status: 'failed', output: [], error: rejection },
              }
            : { type: 'error', ...rejection };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      });
      const events: ProviderEvent[] = [];
      let failure: unknown;
      try {
        await runManaged(
          createClient('https://fixture.invalid/v1', undefined, fetcher),
          context(events),
          'responses',
          [1, 1],
        );
      } catch (error) {
        failure = error;
      }
      const safeDetails = {
        ...(kind === 'http' ? { status: 400 } : {}),
        code,
        param: rejection.param,
      };
      expect(fetcher).toHaveBeenCalledOnce();
      expect(modelErrorDetails(failure)).toEqual(safeDetails);
      expect(modelErrorDetails(providerError(failure))).toEqual(safeDetails);
      const diagnostic = events.find((event) => event.data.phase === 'model-error');
      expect(diagnostic?.data).toMatchObject(safeDetails);
      expect(diagnostic?.data).not.toHaveProperty('message');
      expect(JSON.stringify(events)).not.toContain('private fixture content');
      expect(events.some((event) => event.data.phase === 'model-retry')).toBe(false);
    },
  );
});

function context(events: ProviderEvent[]): RunContext {
  return {
    runId: 'run',
    bot: { model: 'fixture' } as RunContext['bot'],
    connection: {} as RunContext['connection'],
    binding: {} as RunContext['binding'],
    workspacePath: '/workspace',
    prompt: 'hi',
    messages: [],
    instructions: 'Help',
    tools: [],
    signal: new AbortController().signal,
    nativeMcp: { command: '', args: [], env: {} },
    emit: (event) => events.push(event),
    executeTool: async () => 'done',
    getSecret: async () => undefined,
    saveSecret: async () => {},
    persistBinding: () => {},
  };
}
