import { createHash } from 'node:crypto';
import type { ModelMessage } from '../domain/provider.js';
import type { Run } from '../domain/types.js';
import type { State } from './state.js';
import { toolResultMessage } from '../runtime/tool-result-message.js';

const key = (taskId: string, content: string) => `context-projection:${taskId}:${createHash('sha256').update(content).digest('hex')}`;

/** Only Core-generated previews may reuse a reference whose text has different coordinates. */
export function registerContextProjection(state: State, taskId: string, content: string, artifactIds: readonly string[]): void {
  state.storage.setMetadata(key(taskId, content), [...new Set(artifactIds)]);
}

export function contextProjectionIds(state: State, taskId: string, runId: string, message: ModelMessage): string[] {
  const saved = state.storage.metadata(key(taskId, message.content));
  if (typeof saved === 'string') return [saved];
  if (Array.isArray(saved) && saved.every(id => typeof id === 'string')) return saved;
  if (!message.callId) return [];
  const operation = state.storage.get<{ runId: string; name: string; status: string; result?: unknown; modelResult?: unknown }>('tool_operations', `${runId}:${message.callId}`);
  if (!operation || operation.name !== 'read_artifact' || operation.status !== 'succeeded') return [];
  if (state.storage.get<Run>('runs', operation.runId)?.taskId !== taskId) return [];
  const value = operation.modelResult ?? operation.result;
  const text = toolResultMessage(message.callId, value).content;
  if (text !== message.content) return [];
  try {
    const parsed = JSON.parse(text) as { artifactId?: string; reads?: { artifactId?: string; error?: unknown; contentAvailable?: boolean }[] };
    if (typeof parsed.artifactId === 'string') return [parsed.artifactId];
    return Array.isArray(parsed.reads) ? parsed.reads.filter(item => !item.error && item.contentAvailable !== false)
      .flatMap(item => typeof item.artifactId === 'string' ? [item.artifactId] : []) : [];
  } catch { return []; }
}
