import type { ManagedProgress, ManagedProgressChange, ModelMessage } from '../domain/provider.js';
import type { Storage } from './storage.js';

interface ProgressDelta {
  id: string;
  runId: string;
  turnId: string;
  assistantIndex: number;
  message: ModelMessage;
  type: ManagedProgressChange['type'];
}
interface ProgressMetadata { id: string; runId: string; turnId: string; type: 'metadata';
  metadata: Omit<ManagedProgress, 'messages' | 'compaction'>; }

export function saveProgressDelta(storage: Storage, runId: string, progress: ManagedProgress,
  change: ManagedProgressChange): boolean {
  const { assistantIndex } = change;
  const assistant = progress.messages[assistantIndex];
  const message = change.type === 'assistant-item' ? assistant : progress.messages.slice(assistantIndex + 1)
    .find(item => item.role === 'tool' && item.callId === change.callId);
  if (!Number.isSafeInteger(assistantIndex) || assistantIndex < 0 || assistant?.role !== 'assistant' || !message
    || (change.type === 'tool-result' && (progress.phase !== 'tools'
      || !assistant.toolCalls?.some(call => call.id === change.callId))))
    throw new Error('工具检查点增量与当前调用不一致');
  const base = storage.prepare(`SELECT 1 FROM provider_archive
    WHERE id = ? AND json_extract(payload, '$.checkpoint.progress.turnId') = ?`).get(runId, progress.turnId);
  if (!base) return false;
  storage.put('managed_progress_deltas', {
    id: JSON.stringify([runId, progress.turnId, assistantIndex, change.type, message.callId]), runId,
    turnId: progress.turnId, assistantIndex, message, type: change.type,
  } satisfies ProgressDelta);
  const { messages: _messages, compaction: _compaction, ...metadata } = progress;
  storage.put('managed_progress_deltas', { id: JSON.stringify([runId, 'metadata']), runId,
    turnId: progress.turnId, type: 'metadata', metadata } satisfies ProgressMetadata);
  return true;
}

export function replayProgressDeltas(storage: Storage, runId: string, progress: ManagedProgress) {
  const rows = storage.byField<ProgressDelta | ProgressMetadata>('managed_progress_deltas', 'runId', runId)
    .filter(delta => delta.turnId === progress.turnId);
  const metadata = rows.find((delta): delta is ProgressMetadata => delta.type === 'metadata');
  if (metadata) Object.assign(progress, metadata.metadata);
  const deltas = rows.filter((delta): delta is ProgressDelta => delta.type !== 'metadata');
  for (const delta of deltas.filter(delta => delta.type === 'assistant-item').sort((a, b) => a.assistantIndex - b.assistantIndex)) {
    if (delta.assistantIndex > progress.messages.length) throw new Error('模型检查点增量缺少前置消息');
    progress.messages[delta.assistantIndex] = delta.message;
  }
  for (const delta of deltas.filter(delta => delta.type === 'tool-result')) {
    const calls = progress.messages[delta.assistantIndex]?.toolCalls;
    const order = new Map(calls?.map((call, index) => [call.id, index]));
    const position = order.get(delta.message.callId!);
    if (position === undefined) continue;
    const following = progress.messages.slice(delta.assistantIndex + 1);
    if (following.some(message => message.role === 'tool' && message.callId === delta.message.callId)) continue;
    const next = following.findIndex(message => message.role !== 'tool'
      || (order.get(message.callId!) ?? Infinity) > position);
    progress.messages.splice(next < 0 ? progress.messages.length : delta.assistantIndex + 1 + next, 0, delta.message);
  }
}

export function clearProgressDeltas(storage: Storage, runId: string) {
  storage.prepare("DELETE FROM managed_progress_deltas WHERE json_extract(payload, '$.runId') = ?").run(runId);
}
