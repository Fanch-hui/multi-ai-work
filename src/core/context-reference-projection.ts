import { createHash } from 'node:crypto';
import type { ModelMessage } from '../domain/provider.js';
import type { Run } from '../domain/types.js';
import type { State } from './state.js';

const key = (taskId: string, content: string) => `context-projection:${taskId}:${createHash('sha256').update(content).digest('hex')}`;

/** Only Core-generated previews may reuse a reference whose text has different coordinates. */
export function registerContextProjection(state: State, taskId: string, content: string, artifactId: string): void {
  state.storage.setMetadata(key(taskId, content), artifactId);
}

export function contextProjectionId(state: State, taskId: string, runId: string, message: ModelMessage): string | undefined {
  const saved = state.storage.metadata(key(taskId, message.content));
  if (typeof saved === 'string') return saved;
  if (!message.callId) return;
  const operation = state.storage.get<{ runId: string; name: string; status: string; result?: unknown; modelResult?: unknown }>('tool_operations', `${runId}:${message.callId}`);
  if (!operation || operation.name !== 'read_artifact' || operation.status !== 'succeeded') return;
  if (state.storage.get<Run>('runs', operation.runId)?.taskId !== taskId) return;
  const value = operation.modelResult ?? operation.result;
  if ((typeof value === 'string' ? value : JSON.stringify(value)) !== message.content) return;
  if (value && typeof value === 'object' && 'artifactId' in value && typeof value.artifactId === 'string') return value.artifactId;
}
