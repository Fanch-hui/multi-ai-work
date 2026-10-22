import { describe, expect, it } from 'vitest';
import {
  decodeModelCatalog,
  loadOfficialModelCatalog,
  supplementChatGptCatalog,
} from '../src/providers/managed/catalog.js';

describe('model reasoning defaults and update support', () => {
  it('preserves explicitly disabled reasoning and does not import an unsupported default', async () => {
    const result = await supplementChatGptCatalog(
      [
        { id: 'disabled', name: 'Disabled', reasoning: [] },
        { id: 'limited', name: 'Limited', reasoning: ['low'] },
      ],
      async () => [
        {
          id: 'disabled',
          name: 'Official',
          defaultReasoningEffort: 'high',
          supportsReasoningEffortUpdates: true,
        },
        {
          id: 'limited',
          name: 'Official',
          defaultReasoningEffort: 'high',
          supportsReasoningEffortUpdates: true,
        },
      ],
    );
    expect(result[0]).toEqual({ id: 'disabled', name: 'Disabled', reasoning: [] });
    expect(result[1]).not.toHaveProperty('defaultReasoningEffort');
  });

  it('reads provider default effort aliases and keeps explicit false', () => {
    expect(
      decodeModelCatalog(
        {
          data: [
            {
              id: 'api-model',
              default_reasoning_level: 'balanced',
              supports_reasoning_effort_updates: false,
            },
            {
              id: 'camel-model',
              defaultReasoningEffort: 'high',
              supportsReasoningEffortUpdates: true,
            },
            {
              id: 'unknown-model',
              default_reasoning_level: '',
              supports_reasoning_effort_updates: null,
            },
          ],
        },
        false,
      ),
    ).toEqual([
      {
        id: 'api-model',
        name: 'api-model',
        defaultReasoningEffort: 'balanced',
        supportsReasoningEffortUpdates: false,
      },
      {
        id: 'camel-model',
        name: 'camel-model',
        defaultReasoningEffort: 'high',
        supportsReasoningEffortUpdates: true,
      },
      { id: 'unknown-model', name: 'unknown-model' },
    ]);
  });

  it('reads defaults and update support from the official Codex model catalog', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-6.1-sol',
              default_reasoning_level: 'high',
              supports_reasoning_effort_updates: false,
            },
            { slug: 'reasoning-default-only', default_reasoning_level: 'medium' },
          ],
        }),
        { status: 200 },
      );
    const models = await loadOfficialModelCatalog(fetcher as typeof fetch);
    expect(models).toEqual([
      {
        id: 'gpt-6.1-sol',
        name: 'gpt-6.1-sol',
        defaultReasoningEffort: 'high',
        supportsReasoningEffortUpdates: false,
      },
      {
        id: 'reasoning-default-only',
        name: 'reasoning-default-only',
        defaultReasoningEffort: 'medium',
      },
    ]);
  });

  it('supplements only missing fields by exact model ID and preserves explicit false', async () => {
    const models = [
      { id: 'gpt-6.1-sol', name: 'Account model', supportsReasoningEffortUpdates: false },
      { id: 'gpt-6.1-sol-preview', name: 'Similar but distinct' },
      { id: 'explicit-default', name: 'Configured', defaultReasoningEffort: 'low' },
    ];
    const official = [
      {
        id: 'gpt-6.1-sol',
        name: 'Official',
        defaultReasoningEffort: 'high',
        supportsReasoningEffortUpdates: true,
      },
      {
        id: 'gpt-6.1-sol-preview',
        name: 'Official preview',
        defaultReasoningEffort: 'medium',
        supportsReasoningEffortUpdates: false,
      },
      {
        id: 'explicit-default',
        name: 'Official configured',
        defaultReasoningEffort: 'high',
        supportsReasoningEffortUpdates: false,
      },
    ];

    expect(await supplementChatGptCatalog(models, async () => official)).toEqual([
      {
        ...models[0],
        defaultReasoningEffort: 'high',
      },
      {
        ...models[1],
        defaultReasoningEffort: 'medium',
        supportsReasoningEffortUpdates: false,
      },
      {
        ...models[2],
        supportsReasoningEffortUpdates: false,
      },
    ]);
  });
});
