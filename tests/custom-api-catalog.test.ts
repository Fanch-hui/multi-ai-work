import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeContext, RunContext } from '../src/domain/provider.js';
import { decodeModelCatalog } from '../src/providers/managed/catalog.js';
import { CustomApiAdapter } from '../src/providers/managed/index.js';
import { configureProviderFetch } from '../src/providers/network.js';

afterEach(() => configureProviderFetch((input, init) => fetch(input, init)));

describe('custom API reasoning capabilities', () => {
  // https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options
  // https://api-docs.deepseek.com/api/list-models/
  it('reads each model effort declaration in provider order without changing values', () => {
    const models = decodeModelCatalog({ data: [
      { id: 'model-a', reasoning: { supported_efforts: ['high', 'medium', 'low', 'minimal'], default_effort: 'medium' } },
      { id: 'model-b', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
      { id: 'model-c', reasoning: { supported_efforts: [] } },
      { id: 'model-d', effort: { supported_levels: [] } },
      { id: 'model-e', reasoning: { supported_efforts: ['future-level', 'balanced'], mandatory: true } },
    ] }, false);
    expect(models).toEqual([
      { id: 'model-a', name: 'model-a', reasoning: ['high', 'medium', 'low', 'minimal'], reasoningSource: 'provider' },
      { id: 'model-b', name: 'model-b', reasoning: ['low', 'high', 'max'], reasoningSource: 'provider' },
      { id: 'model-c', name: 'model-c', reasoning: [], reasoningSource: 'provider' },
      { id: 'model-d', name: 'model-d', reasoning: [], reasoningSource: 'provider' },
      { id: 'model-e', name: 'model-e', reasoning: ['future-level', 'balanced'], reasoningSource: 'provider' },
    ]);
  });

  it('keeps absent levels unknown when metadata only advertises a parameter, default or support flag', () => {
    const models = decodeModelCatalog({ data: [
      { id: 'plain' },
      { id: 'parameters', supported_parameters: ['reasoning', 'reasoning_effort'] },
      { id: 'flag', supports_reasoning: true, reasoning: true },
      { id: 'default', reasoning: { default_effort: 'high', default_enabled: true } },
      { id: 'unrestricted', reasoning: { supported_efforts: null } },
      { id: 'effort-default', effort: { default_level: 'high' } },
    ] }, false);
    expect(models).toHaveLength(6);
    for (const model of models!) {
      expect(model).not.toHaveProperty('reasoning');
      expect(model).not.toHaveProperty('reasoningSource');
    }
  });

  it.each(['chat-completions', 'responses'] as const)('reads provider effort metadata through the %s /models probe', async protocol => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'model-a', reasoning: { supported_efforts: ['high', 'medium', 'low', 'minimal'] } },
      { id: 'model-b', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
      { id: 'model-c', reasoning: { supported_efforts: [] } },
      { id: 'model-d', object: 'model', created: 0, owned_by: 'provider' },
    ] })));
    configureProviderFetch(fetcher);
    const context = { connection: { provider: 'custom', protocol, baseUrl: 'https://api.example.com/v1', authMode: 'none' },
      signal: new AbortController().signal, getSecret: vi.fn() } as unknown as ProbeContext;
    const result = await new CustomApiAdapter().probe(context);
    expect(result.models).toHaveLength(4);
    expect(result.models[0]).toMatchObject({ id: 'model-a',
      reasoning: ['high', 'medium', 'low', 'minimal'], reasoningSource: 'provider' });
    expect(result.models[1]).toMatchObject({ reasoning: ['low', 'high', 'max'], reasoningSource: 'provider' });
    expect(result.models[2]).toMatchObject({ reasoning: [], reasoningSource: 'provider' });
    expect(result.models[3]).not.toHaveProperty('reasoning');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/models');
    expect(context.getSecret).not.toHaveBeenCalled();
  });

  it.each(['chat-completions', 'responses'] as const)('sends selected extended and advertised future efforts unchanged through %s', async protocol => {
    const requests: Record<string, unknown>[] = [];
    configureProviderFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const event = protocol === 'responses'
        ? { type: 'response.completed', response: { id: 'response', status: 'completed', output: [
          { type: 'message', id: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Done', annotations: [] }] },
        ] } }
        : { id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'model',
          choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(event)}\n\n${protocol === 'chat-completions' ? 'data: [DONE]\n\n' : ''}`,
        { headers: { 'content-type': 'text/event-stream' } });
    });
    for (const effort of ['none', 'minimal', 'xhigh', 'max', 'future-level']) {
      const context = { runId: 'run', bot: { model: 'model', reasoning: effort },
        connection: { provider: 'custom', protocol, baseUrl: 'https://api.example.com/v1', authMode: 'none' },
        binding: {}, workspacePath: '/workspace', prompt: 'Hello', messages: [], instructions: '', tools: [],
        signal: new AbortController().signal, emit: () => {}, getSecret: async () => undefined,
      } as unknown as RunContext;
      expect((await new CustomApiAdapter().run(context)).text).toBe('Done');
      expect(requests.at(-1)).toMatchObject(protocol === 'responses'
        ? { reasoning: { effort } } : { reasoning_effort: effort });
    }
  });
});
