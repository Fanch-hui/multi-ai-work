import type { ModelMessage, RunContext } from '../../domain/provider.js';

const supportedEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function knownReasoningEffort(value: unknown): string | undefined {
  return typeof value === 'string' && supportedEfforts.has(value) ? value : undefined;
}

export function officialResponsesEndpoint(baseURL: string): boolean {
  try {
    const endpoint = new URL(`${baseURL.replace(/\/$/, '')}/responses`);
    return endpoint.origin === 'https://api.openai.com' && endpoint.pathname === '/v1/responses';
  } catch {
    return false;
  }
}

export function selectedReasoningEffort(context: RunContext): string | undefined {
  return context.getReasoningEffort ? context.getReasoningEffort() : context.bot.reasoning;
}

export function reasoningUpdateHistory(messages: ModelMessage[]) {
  return messages.flatMap((message, index) =>
    message.reasoningUpdate ? [{ ...message.reasoningUpdate, index }] : [],
  );
}

export function appendReasoningUpdate(
  messages: ModelMessage[],
  baseline: string,
  effort: string,
): void {
  const history = reasoningUpdateHistory(messages);
  const stableBaseline = history[0]?.baseline ?? baseline;
  if (history.at(-1)?.effort === effort) return;
  messages.push({
    role: 'assistant',
    content: '',
    reasoningUpdate: { baseline: stableBaseline, effort },
  });
}

export function reasoningBaseline(messages: ModelMessage[]): string | undefined {
  return reasoningUpdateHistory(messages)[0]?.baseline;
}
