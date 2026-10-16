import type { ModelMessage } from '../domain/provider.js';
import type { Protocol } from '../domain/types.js';
import { estimateModelMessagesTokens, historyUnits, toolsPaired } from './model-history.js';

const overflowCodes = new Set(['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded']);

export function isContextOverflow(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const structured = error as { code?: unknown; error?: { code?: unknown }; message?: unknown };
  if (typeof structured.code === 'string' && overflowCodes.has(structured.code)) return true;
  if (typeof structured.error?.code === 'string' && overflowCodes.has(structured.error.code)) return true;
  return typeof structured.message === 'string' && [...overflowCodes].some(code => structured.message === `模型响应未完成：${code}`);
}

/** Preserve current user inputs, balanced calls and the latest results or their readable full-output references. */
export function isSmallerProjection(original: ModelMessage[], recovered: ModelMessage[], currentStart?: number, protocol?: Protocol): boolean {
  if (estimateModelMessagesTokens(recovered, protocol) >= estimateModelMessagesTokens(original, protocol)) return false;
  if (currentStart !== undefined) {
    const expectedUsers = original.slice(currentStart).filter(message => message.role === 'user'
      && message.appContext?.source !== 'app.repeat-tool-reminder');
    const actualUsers = recovered.filter(message => message.role === 'user');
    let cursor = 0;
    for (const user of expectedUsers) {
      const index = actualUsers.findIndex((item, index) => index >= cursor && JSON.stringify(item) === JSON.stringify(user));
      if (index < 0) return false;
      cursor = index + 1;
    }
    const history = recovered.map((message, sequence) => ({ message, sequence, messageId: String(sequence) }));
    let latestCall = original.length - 1;
    while (latestCall >= currentStart && !original[latestCall].toolCalls?.length) latestCall--;
    const tail = latestCall >= currentStart ? original.slice(latestCall) : [];
    const retained = recovered.slice(-tail.length);
    const preservesTail = !tail.length || retained.length === tail.length && tail.every((message, index) => {
      const next = retained[index];
      if (JSON.stringify(next) === JSON.stringify(message)) return true;
      return message.role === 'tool' && next.role === 'tool' && next.callId === message.callId
        && next.contextSummary === true && !!next.contextArtifactIds?.length;
    });
    return toolsPaired(history) && preservesTail;
  }
  let current = original.length - 1;
  while (current >= 0 && (original[current].role !== 'user'
    || original[current].appContext?.source === 'app.repeat-tool-reminder')) current--;
  if (current < 0) return false;
  const tail = original.slice(current);
  const history = recovered.map((message, sequence) => ({ message, sequence, messageId: String(sequence) }));
  return historyUnits(history).every(toolsPaired) && recovered.length >= tail.length
    && JSON.stringify(recovered.slice(-tail.length)) === JSON.stringify(tail);
}
