import type { RunEvent } from '../../../src/domain/types.js';
import { isWorkEvent } from './run-work-actions.js';

const summaryFields = new Set([
  'name',
  'callId',
  'summary',
  'status',
  'phase',
  'source',
  'commandStatus',
  'exitCode',
  'attempt',
  'maxAttempts',
  'nextAttemptAt',
  'trigger',
  'owner',
  'id',
  'questionId',
  'approvalId',
]);

export function workRecordEvents(events: RunEvent[]): RunEvent[] {
  return events.filter(isWorkEvent).map((event) => ({
    ...event,
    data: Object.fromEntries(
      Object.entries(event.data)
        .filter(
          ([key, value]) =>
            summaryFields.has(key) && ['string', 'number', 'boolean'].includes(typeof value),
        )
        .map(([key, value]) => [
          key,
          key === 'summary' && typeof value === 'string' ? value.slice(0, 240) : value,
        ]),
    ),
  }));
}

// Event IDs are immutable. Existing cached events take precedence over older pages.
export function mergeRecordEvents(previous: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  return [...new Map([...incoming, ...previous].map((event) => [event.id, event])).values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt),
  );
}
