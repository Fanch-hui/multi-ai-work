import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Artifact, Task } from '../domain/types.js';
import { estimateTokens } from '../runtime/model-history.js';
import type { State } from './state.js';
import type { ContextReference } from './context-references.js';

export const referenceIndexSource = 'context-reference-index';
const maxReferenceTokens = 1000;
const heading = '可按当前权限读取的资料：';

function row(ref: ContextReference): string {
  return JSON.stringify({ name: ref.name.slice(0, 200), tool: ref.kind === 'artifact' ? 'read_artifact' : 'get_task',
    arguments: ref.kind === 'artifact' ? { artifactId: ref.id } : { taskId: ref.id } });
}

export function formatContextReferences(references: readonly ContextReference[], directory?: ContextReference): string {
  const refs = [...new Map(references.map(ref => [`${ref.kind}:${ref.id}`, ref])).values()];
  if (!refs.length) return '';
  const footer = directory ? `完整资料目录（可用 read_artifact 的 offset/limit 分页）：\n${row(directory)}` : '';
  const lines = [heading];
  for (const ref of refs) {
    const next = row(ref);
    if (estimateTokens([...lines, next, footer].filter(Boolean).join('\n')) > maxReferenceTokens) break;
    lines.push(next);
  }
  if (footer) lines.push(footer);
  return lines.join('\n');
}

export function needsReferenceIndex(references: readonly ContextReference[]): boolean {
  return estimateTokens([heading, ...references.map(row)].join('\n')) > maxReferenceTokens;
}

export function saveReferenceIndex(state: State, task: Task, references: readonly ContextReference[]): ContextReference {
  const s = state.storage;
  const existing = s.get<Task>('tasks', task.id)?.artifactIds.map(id => s.get<Artifact>('artifacts', id))
    .find(artifact => artifact?.source === referenceIndexSource);
  const id = existing?.id ?? randomUUID();
  const content = references.map(row).join('\n'), key = `artifact-text:${id}`;
  const artifact: Artifact = { id, name: '工具资料目录.txt', path: join(state.dataDirectory, 'artifacts', id, 'tool-output.txt'),
    mimeType: 'text/plain', sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content),
    taskId: task.id, botId: task.botId, conversationId: task.conversationId, createdAt: existing?.createdAt ?? new Date().toISOString(),
    source: referenceIndexSource, purpose: 'intermediate', contentSource: { kind: 'stored-text', key } };
  s.transaction(() => {
    s.setMetadata(key, content); s.put('artifacts', artifact);
    const current = s.get<Task>('tasks', task.id)!;
    if (!current.artifactIds.includes(id)) s.put('tasks', { ...current, artifactIds: [...current.artifactIds, id] });
  });
  state.changed();
  return { kind: 'artifact', id, name: artifact.name };
}
