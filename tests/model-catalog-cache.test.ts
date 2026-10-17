import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureProviderFetch } from '../src/providers/network.js';
import {
  OFFICIAL_CATALOG_FAILURE_BACKOFF_MS,
  OFFICIAL_CATALOG_TTL_MS,
  resetOfficialCatalogCache,
  supplementChatGptCatalog,
} from '../src/providers/managed/catalog.js';

beforeEach(() => resetOfficialCatalogCache());
afterEach(() => {
  vi.useRealTimers();
  resetOfficialCatalogCache();
  configureProviderFetch((input, init) => fetch(input, init));
});

it('retries a failed official catalog request after the 30s backoff window and shares the successful cache', async () => {
  vi.useFakeTimers();
  const models = [{ id: 'fixture-model', name: 'Account model' }];
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Offline'))
    .mockImplementation(async () => new Response(JSON.stringify({ models: [{ slug: 'fixture-model',
      max_context_window: 96000, supported_reasoning_levels: [{ effort: 'high' }], input_modalities: ['text'] }] })));
  configureProviderFetch(fetcher);
  const failed = await Promise.all([supplementChatGptCatalog(models), supplementChatGptCatalog(models)]);
  expect(failed).toEqual([models, models]);
  expect(fetcher).toHaveBeenCalledTimes(1);

  // Within the 30s failure backoff window, fast-fallback without hitting the network.
  expect(await supplementChatGptCatalog(models)).toEqual(models);
  expect(fetcher).toHaveBeenCalledTimes(1);

  // After the 30s failure backoff window expires, retry succeeds and caches the result.
  vi.advanceTimersByTime(OFFICIAL_CATALOG_FAILURE_BACKOFF_MS + 1);
  const recovered = await Promise.all([supplementChatGptCatalog(models), supplementChatGptCatalog(models)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(recovered[0][0]).toMatchObject({ id: 'fixture-model', maxContextWindow: 96000,
    reasoning: ['high'], reasoningSource: 'official-catalog' });
  expect(await supplementChatGptCatalog(models)).toEqual(recovered[0]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('falls back to the stale cached catalog when a post-TTL refresh fails and updates when a later refresh succeeds', async () => {
  vi.useFakeTimers();
  const models = [{ id: 'fixture-model', name: 'Account model' }];
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(JSON.stringify({ models: [{ slug: 'fixture-model',
      max_context_window: 96000, supported_reasoning_levels: [{ effort: 'medium' }], input_modalities: ['text'] }] })))
    .mockRejectedValueOnce(new Error('Refresh offline'))
    .mockImplementationOnce(async () => new Response(JSON.stringify({ models: [{ slug: 'fixture-model',
      max_context_window: 128000, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }], input_modalities: ['text', 'image'] }] })));
  configureProviderFetch(fetcher);

  const initial = await supplementChatGptCatalog(models);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(initial[0]).toMatchObject({ maxContextWindow: 96000, reasoning: ['medium'] });

  // Expire the 30-minute TTL; refresh fails, so stale cache is preserved.
  vi.advanceTimersByTime(OFFICIAL_CATALOG_TTL_MS + 1);
  const stale = await Promise.all([supplementChatGptCatalog(models), supplementChatGptCatalog(models)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(stale[0]).toEqual(initial);

  // After the failure backoff window, refresh succeeds with updated capabilities.
  vi.advanceTimersByTime(OFFICIAL_CATALOG_FAILURE_BACKOFF_MS + 1);
  const refreshed = await supplementChatGptCatalog(models);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(refreshed[0]).toMatchObject({ maxContextWindow: 128000, reasoning: ['medium', 'high'], imageInput: 'supported' });
});
