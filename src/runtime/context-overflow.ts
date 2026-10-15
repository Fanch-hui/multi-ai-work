import type { ModelMessage } from '../domain/provider.js';
import { estimateTokens, historyUnits, toolsPaired } from './model-history.js';

const overflowCodes = new Set(['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded']);

export function isContextOverflow(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const structured = error as { code?: unknown; error?: { code?: unknown }; message?: unknown };
  if (typeof structured.code === 'string' && overflowCodes.has(structured.code)) return true;
  if (typeof structured.error?.code === 'string' && overflowCodes.has(structured.error.code)) return true;
  return typeof structured.message === 'string' && [...overflowCodes].some(code => structured.message === `模型响应未完成：${code}`);
}

/** Current request and completed tool results must survive recovery byte for byte. */
export function isSmallerProjection(original: ModelMessage[], recovered: ModelMessage[]): boolean {
  if (estimateTokens(recovered) >= estimateTokens(original)) return false;
  let current = original.length - 1;
  while (current >= 0 && original[current].role !== 'user') current--;
  if (current < 0) return false;
  const tail = original.slice(current);
  const history = recovered.map((message, sequence) => ({ message, sequence, messageId: String(sequence) }));
  return historyUnits(history).every(toolsPaired) && recovered.length >= tail.length
    && JSON.stringify(recovered.slice(-tail.length)) === JSON.stringify(tail);
}
