import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Response, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { ResponsesCacheDiagnostics } from '../src/providers/managed/cache-diagnostics.js';
import { responsesInput } from '../src/providers/managed/messages.js';

function context(events: ProviderEvent[], provider = 'chatgpt', model = 'gpt-6.1-sol') {
  return {
    connection: { provider } as RunContext['connection'],
    bot: { model } as RunContext['bot'],
    emit: (event: ProviderEvent) => {
      events.push(event);
    },
  } as RunContext;
}
const body = (): ResponseCreateParamsStreaming => ({
  model: 'gpt-6.1-sol',
  stream: true,
  store: false,
  instructions: 'private instructions',
  tools: [
    {
      type: 'function',
      name: 'read',
      description: 'private tool description',
      parameters: {},
      strict: false,
    },
  ],
  input: [{ role: 'user', content: 'private user content' }],
});
const response = (id = 'resp_1') =>
  ({
    id,
    model: 'gpt-6.1-sol',
    service_tier: 'default',
    usage: {
      input_tokens: 2000,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2000 },
    },
  }) as Response;

describe('request cache diagnostics', () => {
  it('compares an appended input against the completed request without recording source content', () => {
    const events: ProviderEvent[] = [],
      ctx = context(events),
      tracker = new ResponsesCacheDiagnostics();
    const initial = tracker.begin(ctx, 'run:1', body());
    expect(initial.options).toEqual({});
    initial.complete(response());
    const next = body();
    next.input = [
      ...(Array.isArray(next.input) ? next.input : []),
      { role: 'user', content: 'new private content' },
    ];
    const trace = tracker.begin(ctx, 'run:2', next);
    expect(trace.options).toEqual({ prompt_cache_options: { comparison_response_id: 'resp_1' } });
    expect(events.at(-1)?.data).toMatchObject({
      baselineRequestId: 'run:1',
      baselineInputItems: 1,
      inputItems: 2,
      sharedInputItems: 1,
      changedFields: [],
      inputPrefixUnchanged: true,
    });
    expect(events[1].data).toMatchObject({
      cachedInputTokens: 0,
      cacheWriteTokens: 2000,
      diagnostics: { type: 'not_reported' },
    });
    expect(JSON.stringify(events)).not.toContain('private');
    expect(JSON.stringify(events)).not.toContain('comparison_response_id');
  });

  it('identifies rewritten history and changed instructions, tools and settings', () => {
    const events: ProviderEvent[] = [],
      ctx = context(events),
      tracker = new ResponsesCacheDiagnostics();
    tracker.begin(ctx, 'run:1', body()).complete(response());
    const next = body();
    next.instructions = 'changed';
    next.tools = [];
    next.reasoning = { effort: 'high' };
    next.input = [{ role: 'user', content: 'changed history' }];
    tracker.begin(ctx, 'run:2', next);
    expect(events.at(-1)?.data).toMatchObject({
      sharedInputItems: 0,
      inputPrefixUnchanged: false,
      changedFields: ['instructions', 'tools', 'settings'],
    });
  });

  it.each([
    ['custom', 'gpt-6.1-sol'],
    ['chatgpt', 'gpt-5.5'],
    ['chatgpt', 'unknown'],
  ])('keeps remote options unchanged for %s / %s', (provider, model) => {
    const events: ProviderEvent[] = [],
      ctx = context(events, provider, model),
      tracker = new ResponsesCacheDiagnostics();
    tracker.begin(ctx, 'run:1', body()).complete(response());
    expect(tracker.begin(ctx, 'run:2', body()).options).toEqual({});
    expect(events.at(-1)?.data.inputPrefixUnchanged).toBe(true);
  });

  it('does not advance the baseline for failed attempts or share it across runs', () => {
    const events: ProviderEvent[] = [],
      ctx = context(events),
      tracker = new ResponsesCacheDiagnostics();
    tracker.begin(ctx, 'run:1', body()).complete(response());
    tracker.begin(ctx, 'run:2', { ...body(), instructions: 'failed attempt' });
    expect(tracker.begin(ctx, 'run:3', body()).options).toEqual({
      prompt_cache_options: { comparison_response_id: 'resp_1' },
    });
    expect(events.at(-1)?.data).toMatchObject({ baselineRequestId: 'run:1', changedFields: [] });
    expect(new ResponsesCacheDiagnostics().begin(ctx, 'summary:1', body()).options).toEqual({});
  });

  it('records only selected response metadata and distinguishes missing usage', () => {
    const events: ProviderEvent[] = [],
      ctx = context(events),
      tracker = new ResponsesCacheDiagnostics();
    const result = {
      ...response(),
      usage: undefined,
      prompt_cache_diagnostics: {
        type: 'cache_miss',
        reason: 'input_changed',
        cache_missed_tokens: 2000,
        comparison_reusable_tokens: 2000,
        extra: 'private data',
      },
    } as Response;
    tracker.begin(ctx, 'run:1', body()).complete(result);
    expect(events.at(-1)?.data.diagnostics).toEqual({
      type: 'cache_miss',
      reason: 'input_changed',
      cacheMissedTokens: 2000,
      comparisonReusableTokens: 2000,
    });
    expect(events.at(-1)?.data).not.toHaveProperty('cachedInputTokens');
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('hashes the full input and its items in one serialization pass', () => {
    const events: ProviderEvent[] = [],
      ctx = context(events),
      tracker = new ResponsesCacheDiagnostics();
    let reads = 0;
    const item = {
      role: 'user' as const,
      get content() {
        reads++;
        return 'private large input'.repeat(1000);
      },
    };
    const input = [item, { role: 'user' as const, content: 'next' }];
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          { role: 'user', content: 'private large input'.repeat(1000) },
          { role: 'user', content: 'next' },
        ]),
      )
      .digest('hex');
    tracker.begin(ctx, 'run:1', { ...body(), input });
    expect(reads).toBe(1);
    expect(events.at(-1)?.data.fingerprints).toMatchObject({ input: expected });
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('distinguishes preserved request input from rewritten confirmed output', () => {
    const events: ProviderEvent[] = [],
      ctx = context(events),
      tracker = new ResponsesCacheDiagnostics();
    const output: Response['output'] = [
      {
        type: 'reasoning',
        id: 'reasoning_1',
        summary: [],
        encrypted_content: 'private encrypted state',
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read',
        arguments: '{"path":"private.txt"}',
        status: 'completed',
      },
    ];
    const initial = body();
    tracker.begin(ctx, 'run:1', initial).complete({ ...response(), output });
    const next = {
      ...body(),
      input: [
        ...(initial.input as unknown[]),
        ...responsesInput([
          { role: 'assistant', content: '', providerItems: output },
          { role: 'tool', callId: 'call_1', content: 'private tool result' },
        ]),
      ],
    } as ResponseCreateParamsStreaming;
    tracker.begin(ctx, 'run:2', next);
    expect(events.at(-1)?.data).toMatchObject({
      inputPrefixUnchanged: true,
      baselineOutputItems: 2,
      sharedOutputItems: 2,
      confirmedPrefixUnchanged: true,
    });
    const rewritten = structuredClone(next);
    (rewritten.input as Response['output'])[2] = {
      ...output[1],
      arguments: '{"path":"other.txt"}',
    } as Response['output'][number];
    tracker.begin(ctx, 'run:3', rewritten);
    expect(events.at(-1)?.data).toMatchObject({
      inputPrefixUnchanged: true,
      sharedOutputItems: 1,
      confirmedPrefixUnchanged: false,
    });
    tracker.begin(ctx, 'run:4', { ...next, instructions: 'different instructions' });
    expect(events.at(-1)?.data).toMatchObject({
      sharedOutputItems: 2,
      changedFields: ['instructions'],
      confirmedPrefixUnchanged: false,
    });
    expect(JSON.stringify(events)).not.toContain('private');
  });
});
