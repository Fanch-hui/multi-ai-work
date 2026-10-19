import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ArtifactContentSource } from '../domain/artifact-content.js';
import type { Artifact, Run, Task } from '../domain/types.js';
import { toolResultMessage } from '../runtime/tool-result-message.js';
import type { Storage } from './storage.js';

export interface ArtifactContentLookup {
  operation(id: string): unknown;
  text(key: string): unknown;
}
interface Operation {
  id: string;
  runId: string;
  status: string;
  result?: unknown;
  modelResult?: unknown;
}
export const maxArtifactBytes = 25 * 1024 * 1024;

export function artifactContentLookup(storage: Storage): ArtifactContentLookup {
  return {
    operation: (id) => storage.get('tool_operations', id),
    text: (key) => storage.metadata(key),
  };
}

export function sourceContent(
  source: ArtifactContentSource,
  lookup: ArtifactContentLookup,
): string | undefined {
  if (source.kind === 'stored-text') {
    const text = lookup.text(source.key);
    return typeof text === 'string' ? text : undefined;
  }
  const operation = lookup.operation(source.operationId) as Operation | undefined;
  if (operation?.status !== 'succeeded' || !Object.hasOwn(operation, source.field)) return;
  return encodedContent(operation[source.field], source.encoding);
}

function encodedContent(value: unknown, encoding: 'value' | 'model-text'): string | undefined {
  return encoding === 'model-text'
    ? toolResultMessage('', value).content
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
}

export function matchesArtifact(
  bytes: Uint8Array,
  artifact: Pick<Artifact, 'size' | 'sha256'>,
): boolean {
  return (
    bytes.byteLength === artifact.size &&
    bytes.byteLength <= maxArtifactBytes &&
    createHash('sha256').update(bytes).digest('hex') === artifact.sha256
  );
}

export async function readArtifactBytes(
  artifact: Artifact,
  lookup: ArtifactContentLookup,
): Promise<Buffer> {
  if (!artifact.contentSource) return readFile(artifact.path);
  const content = sourceContent(artifact.contentSource, lookup);
  if (content !== undefined) {
    const bytes = Buffer.from(content);
    if (matchesArtifact(bytes, artifact)) return bytes;
  }
  const bytes = await readFile(artifact.path);
  if (!matchesArtifact(bytes, artifact)) throw new Error('完整工具结果校验失败');
  return bytes;
}

export function findArtifactContentSource(
  storage: Storage,
  taskId: string,
  content: string,
  hint?: { runId?: string; callId?: string },
): ArtifactContentSource | undefined {
  const task = storage.get<Task>('tasks', taskId);
  if (!task || Buffer.byteLength(content) > maxArtifactBytes) return;
  const match = (operation: Operation | undefined): ArtifactContentSource | undefined => {
    if (!operation || operation.status !== 'succeeded') return;
    const run = storage.get<Run>('runs', operation.runId);
    if (!run || run.taskId !== taskId || run.botId !== task.botId) return;
    for (const field of ['modelResult', 'result'] as const) {
      if (!Object.hasOwn(operation, field)) continue;
      for (const encoding of ['model-text', 'value'] as const) {
        if (encodedContent(operation[field], encoding) === content)
          return { kind: 'tool-operation', operationId: operation.id, field, encoding };
      }
    }
  };
  if (hint?.runId && hint.callId) {
    const exact = match(storage.get<Operation>('tool_operations', `${hint.runId}:${hint.callId}`));
    if (exact) return exact;
  }
  const runs = storage.byField<Run>('runs', 'taskId', taskId);
  for (const run of runs) {
    for (const operation of storage.byField<Operation>('tool_operations', 'runId', run.id)) {
      const found = match(operation);
      if (found) return found;
    }
  }
}
