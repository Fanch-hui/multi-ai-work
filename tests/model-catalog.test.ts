import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeContext } from '../src/domain/provider.js';
import {
  decodeModelCatalog,
  loadOfficialModelCatalog,
  resetOfficialCatalogCache,
  supplementChatGptCatalog,
} from '../src/providers/managed/catalog.js';
import { modelCatalog } from '../src/providers/managed/client.js';

beforeEach(() => resetOfficialCatalogCache());
afterEach(() => resetOfficialCatalogCache());

// Field structure from openai/codex, codex-rs/models-manager/models.json.
const chatGptModel = {
  slug: 'gpt-6.1-sol',
  display_name: 'GPT-6.1-Sol',
  visibility: 'list',
  context_window: 272000,
  max_context_window: 872000,
  supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({
    effort,
  })),
};

describe('advertised model reasoning capabilities', () => {
  it('preserves ChatGPT model ordering, visibility, context and advertised reasoning levels', () => {
    const models = decodeModelCatalog(
      {
        models: [
          chatGptModel,
          { ...chatGptModel, slug: 'hidden', visibility: 'hide' },
          { slug: 'plain-model', visibility: 'list' },
        ],
      },
      true,
    );
    expect(models).toEqual([
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1-Sol',
        contextWindow: 272000,
        maxContextWindow: 872000,
        maxContextWindowSource: 'provider',
        reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        reasoningSource: 'provider',
      },
      { id: 'plain-model', name: 'plain-model' },
    ]);
  });

  it('keeps the default and supported maximum distinct, including explicit API catalog fields', () => {
    expect(
      decodeModelCatalog(
        { data: [{ id: 'custom', contextWindow: 32000, maxContextWindow: 96000 }] },
        false,
      ),
    ).toEqual([
      {
        id: 'custom',
        name: 'custom',
        contextWindow: 32000,
        maxContextWindow: 96000,
        maxContextWindowSource: 'provider',
      },
    ]);
    expect(
      decodeModelCatalog(
        {
          models: [
            {
              slug: 'account',
              visibility: 'list',
              context_window: 272000,
              max_context_window: 500000,
            },
          ],
        },
        true,
      )?.[0],
    ).toMatchObject({ contextWindow: 272000, maxContextWindow: 500000 });
  });

  it('retains exact future effort values and deduplicates explicit alias fields', () => {
    expect(
      decodeModelCatalog(
        {
          data: [
            {
              id: 'future',
              supportedReasoningEfforts: [
                { reasoningEffort: 'high', description: 'High' },
                { reasoningEffort: 'future-effort' },
              ],
              supported_reasoning_efforts: [{ reasoning_effort: 'high' }],
              reasoning_efforts: ['high', 'future-effort', '', ' ', null],
            },
          ],
        },
        false,
      ),
    ).toEqual([
      {
        id: 'future',
        name: 'future',
        reasoning: ['high', 'future-effort'],
        reasoningSource: 'provider',
      },
    ]);
  });

  it('does not infer capabilities from model names or generic reasoning support flags', () => {
    expect(
      decodeModelCatalog(
        { models: [{ slug: 'gpt-6.1-sol', visibility: 'list', supports_reasoning: true }] },
        true,
      ),
    ).toEqual([{ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' }]);
    expect(decodeModelCatalog({ data: [{ id: 'gpt-6.1-sol' }] }, false)).toEqual([
      { id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' },
    ]);
    expect(decodeModelCatalog({ data: [{ id: 'ignored' }] }, true)).toBeUndefined();
  });

  it('projects advertised efforts through the HTTP probe without losing them', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          models: [
            {
              ...chatGptModel,
              supports_images: true,
              default_reasoning_level: 'high',
              supports_reasoning_effort_updates: false,
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local catalog server');
      const context = {
        connection: { provider: 'custom', baseUrl: `http://127.0.0.1:${address.port}/v1` },
        signal: new AbortController().signal,
      } as ProbeContext;
      const models = await modelCatalog(context, undefined, true);
      expect(models[0]?.reasoning).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe('official ChatGPT catalog supplement', () => {
  it('matches exact IDs without adding models, changing model settings or replacing provider capabilities', async () => {
    const models = [
      { id: 'gpt-6.1-sol', name: 'Account model', contextWindow: 128000 },
      {
        id: 'future',
        name: 'Future',
        reasoning: ['future-effort'],
        reasoningSource: 'provider' as const,
      },
      { id: 'gpt-6.1-sol-preview', name: 'Unmatched' },
      {
        id: 'plain',
        name: 'Explicit unsupported',
        reasoning: [],
        reasoningSource: 'provider' as const,
      },
    ];
    const load = async () => [
      {
        id: 'gpt-6.1-sol',
        name: 'Official name',
        contextWindow: 272000,
        reasoning: ['low', 'high'],
      },
      { id: 'future', name: 'Future', reasoning: ['high'] },
      { id: 'extra', name: 'Not in account', reasoning: ['high'] },
      { id: 'plain', name: 'Plain', reasoning: ['high'] },
    ];
    expect(await supplementChatGptCatalog(models, load)).toEqual([
      { ...models[0], reasoning: ['low', 'high'], reasoningSource: 'official-catalog' },
      models[1],
      models[2],
      models[3],
    ]);
    expect(models[0]).not.toHaveProperty('reasoning');
  });

  it('fills a missing maximum by exact ID even when reasoning was advertised, retaining the default and account maximum', async () => {
    const models = [
      { id: 'gpt-6.1-sol', name: 'Account', contextWindow: 272000, reasoning: ['high'] },
      {
        id: 'limited',
        name: 'Limited',
        contextWindow: 128000,
        maxContextWindow: 300000,
        maxContextWindowSource: 'provider' as const,
      },
      { id: 'gpt-6.1-sol-preview', name: 'Unmatched', contextWindow: 272000 },
    ];
    const load = async () => [
      {
        id: 'gpt-6.1-sol',
        name: 'Official',
        contextWindow: 272000,
        maxContextWindow: 872000,
        reasoning: ['low', 'high'],
      },
      { id: 'limited', name: 'Official', maxContextWindow: 872000 },
    ];
    expect(await supplementChatGptCatalog(models, load)).toEqual([
      { ...models[0], maxContextWindow: 872000, maxContextWindowSource: 'official-catalog' },
      models[1],
      models[2],
    ]);
    expect(models[0]).not.toHaveProperty('maxContextWindow');
  });

  it('returns the original account catalog when official capabilities are absent or the request fails', async () => {
    const models = [{ id: 'model', name: 'Model' }];
    expect(
      await supplementChatGptCatalog(models, async () => [{ id: 'model', name: 'Model' }]),
    ).toEqual(models);
    expect(
      await supplementChatGptCatalog(models, async () => {
        throw new Error('Offline');
      }),
    ).toBe(models);
    const failedFetch = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Offline'));
    expect(
      await supplementChatGptCatalog(models, () => loadOfficialModelCatalog(failedFetch)),
    ).toBe(models);
    const unavailableFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 503 }));
    expect(
      await supplementChatGptCatalog(models, () => loadOfficialModelCatalog(unavailableFetch)),
    ).toBe(models);
    expect(
      decodeModelCatalog(
        { models: [{ slug: 'model', visibility: 'list', supported_reasoning_levels: [] }] },
        true,
      ),
    ).toEqual([{ id: 'model', name: 'model', reasoning: [], reasoningSource: 'provider' }]);
  });

  it('reads only the fixed public official URL without account credentials and ignores non-level aliases', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [chatGptModel, { slug: 'ignored', reasoning_efforts: ['high'] }],
        }),
        { status: 200 },
      ),
    );
    const models = await loadOfficialModelCatalog(fetcher);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe(
      'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json',
    );
    expect(request).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request).not.toHaveProperty('headers');
    expect(models.map((model) => model.id)).toEqual(['gpt-6.1-sol']);
    expect(models[0]?.reasoning).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(models[0]).toMatchObject({ contextWindow: 272000, maxContextWindow: 872000 });
  });

  it('skips the public request when the provider already declared every model capability', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const models = [
      {
        id: 'model',
        name: 'Model',
        reasoning: ['high'],
        maxContextWindow: 96000,
        imageInput: 'supported' as const,
        defaultReasoningEffort: 'high',
        supportsReasoningEffortUpdates: false,
      },
    ];
    expect(await supplementChatGptCatalog(models, load)).toBe(models);
    expect(load).not.toHaveBeenCalled();
  });

  it('supplements two account probes with a single public request', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          models: [
            { slug: 'gpt-6.1-sol', display_name: 'Account model', visibility: 'list' },
            { slug: 'unmatched', visibility: 'list' },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const nativeFetch = globalThis.fetch;
    const fetcher = vi.fn<typeof fetch>((url, request) =>
      String(url).startsWith('https://raw.githubusercontent.com/')
        ? Promise.resolve(new Response(JSON.stringify({ models: [chatGptModel] }), { status: 200 }))
        : nativeFetch(url, request),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local catalog server');
      const context = {
        connection: { provider: 'custom', baseUrl: `http://127.0.0.1:${address.port}/v1` },
        signal: new AbortController().signal,
      } as ProbeContext;
      const probes = await Promise.all([
        modelCatalog(context, undefined, true),
        modelCatalog(context, undefined, true),
      ]);
      for (const models of probes) {
        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({
          id: 'gpt-6.1-sol',
          name: 'Account model',
          reasoningSource: 'official-catalog',
        });
        expect(models[1]).not.toHaveProperty('reasoning');
      }
      const officialRequests = fetcher.mock.calls.filter(([url]) =>
        String(url).startsWith('https://raw.githubusercontent.com/'),
      );
      expect(officialRequests).toHaveLength(1);
      expect(officialRequests[0][1]).not.toHaveProperty('headers');
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
