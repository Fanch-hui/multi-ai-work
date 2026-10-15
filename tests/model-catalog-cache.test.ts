import { afterEach, expect, it, vi } from 'vitest';
import { configureProviderFetch } from '../src/providers/network.js';
import { supplementChatGptCatalog } from '../src/providers/managed/catalog.js';

afterEach(() => configureProviderFetch((input, init) => fetch(input, init)));

it('retries a failed official catalog request and then shares the successful cache', async () => {
  const models = [{ id: 'fixture-model', name: 'Account model' }];
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Offline'))
    .mockImplementation(async () => new Response(JSON.stringify({ models: [{ slug: 'fixture-model',
      max_context_window: 96000, supported_reasoning_levels: [{ effort: 'high' }], input_modalities: ['text'] }] })));
  configureProviderFetch(fetcher);
  const failed = await Promise.all([supplementChatGptCatalog(models), supplementChatGptCatalog(models)]);
  expect(failed).toEqual([models, models]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const recovered = await Promise.all([supplementChatGptCatalog(models), supplementChatGptCatalog(models)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(recovered[0][0]).toMatchObject({ id: 'fixture-model', maxContextWindow: 96000,
    reasoning: ['high'], reasoningSource: 'official-catalog' });
  expect(await supplementChatGptCatalog(models)).toEqual(recovered[0]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
