import type { ModelMessage } from '../domain/provider.js';

/** Keep completed results next to their assistant and in the original call order. */
export function insertOrderedToolResult(
  messages: ModelMessage[],
  assistantIndex: number,
  result: ModelMessage,
): boolean {
  const calls = messages[assistantIndex]?.toolCalls;
  const order = new Map(calls?.map((call, index) => [call.id, index]));
  const position = order.get(result.callId!);
  if (position === undefined) return false;
  const following = messages.slice(assistantIndex + 1);
  if (following.some((message) => message.role === 'tool' && message.callId === result.callId)) {
    return false;
  }
  const next = following.findIndex(
    (message) => message.role !== 'tool' || (order.get(message.callId!) ?? Infinity) > position,
  );
  const insertion = next < 0 ? messages.length : assistantIndex + 1 + next;
  messages.splice(insertion, 0, result);
  return true;
}
