import { expect, it, vi } from 'vitest';
import type { ProviderEvent, RunContext } from '../src/domain/provider.js';
import { createClient } from '../src/providers/managed/client.js';
import { runManaged } from '../src/providers/managed/loop.js';

it('shows streamed Chat refusal text and fails the task without retrying or running tools', async () => {
  const events: ProviderEvent[] = [];
  const executeTool = vi.fn(async () => ({}));
  const fetcher = vi.fn(async () => {
    const chunks = [
      { delta: { role: 'assistant', refusal: '无法处理' }, finish_reason: null },
      { delta: { refusal: '此请求。' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ];
    return new Response(
      chunks
        .map((choice) => `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`)
        .join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const context = {
    runId: 'refusal-run',
    bot: { model: 'fixture-model' },
    connection: { provider: 'custom', protocol: 'chat-completions' },
    binding: { id: 'binding', generation: 1 },
    prompt: 'fixture request',
    messages: [],
    instructions: '',
    tools: [],
    signal: new AbortController().signal,
    emit: (event: ProviderEvent) => events.push(event),
    executeTool,
  } as unknown as RunContext;

  await expect(
    runManaged(
      createClient('https://fixture.invalid/v1', undefined, fetcher),
      context,
      'chat-completions',
      [1],
    ),
  ).rejects.toThrow('模型拒绝执行该请求');

  expect(events.filter((event) => event.type === 'text').map((event) => event.data.delta)).toEqual([
    '无法处理',
    '此请求。',
  ]);
  expect(events.some((event) => event.data.phase === 'model-error')).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(executeTool).not.toHaveBeenCalled();
});
