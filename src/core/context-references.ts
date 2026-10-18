import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from '../domain/provider.js';
import type { Artifact, Bot, Conversation, Run, Task } from '../domain/types.js';
import type { State } from './state.js';
import { scopedTask } from './task-access.js';
import { accessibleArtifacts } from './tool-access.js';
import { contextProjectionId, registerContextProjection } from './context-reference-projection.js';
import { formatContextReferences, needsReferenceIndex, referenceIndexSource, saveReferenceIndex } from './context-reference-index.js';
export { formatContextReferences } from './context-reference-index.js';

export interface ContextReference { kind: 'artifact' | 'task'; id: string; name: string; }
interface ReferenceScope { runId: string; task: Task; bot: Bot; room: Conversation; toolNames: readonly string[]; signal: AbortSignal; inlineToolLimit?: number; }
const maxReadableBytes = 25 * 1024 * 1024;

export class ContextReferences {
  private previous: ContextReference[] = [];
  constructor(private state: State, private scope: ReferenceScope) {}

  async preserveReferences(messages: readonly ModelMessage[], previousArtifactIds: readonly string[] = []): Promise<{ text: string; artifactIds: string[] }> {
    const previous = previousArtifactIds.map(id => ({ kind: 'artifact' as const, id, name: '' }));
    const limit = this.scope.inlineToolLimit ?? 32000;
    for (const message of messages) {
      if (message.role !== 'tool' || message.content.length <= Math.min(1200, limit)) continue;
      const reference = await this.preserveToolOutput(message);
      if (!reference) {
        message.contextArtifactIds = undefined;
        if (message.content.length > limit) throw new Error('完整工具结果无法通过当前授权读取，保留原上下文');
        continue;
      }
      message.contextArtifactIds = [...new Set([reference.id, ...(message.contextArtifactIds ?? [])])];
      this.previous.push(reference);
    }
    this.previous = await this.collect(messages, [...this.previous, ...previous]);
    const directory = needsReferenceIndex(this.previous) && this.allowed('read_artifact')
      ? saveReferenceIndex(this.state, this.scope.task, this.previous) : undefined;
    return { text: formatContextReferences(this.previous, directory),
      artifactIds: [...new Set([...this.previous.filter(ref => ref.kind === 'artifact').map(ref => ref.id), ...(directory ? [directory.id] : [])])] };
  }

  async collect(messages: readonly ModelMessage[], previous: readonly ContextReference[] = []): Promise<ContextReference[]> {
    this.scope.signal.throwIfAborted();
    const s = this.state.storage, refs: ContextReference[] = [];
    const task = s.get<Task>('tasks', this.scope.task.id);
    if (this.allowed('read_artifact')) {
      const ids = new Set(previous.filter(ref => ref.kind === 'artifact').map(ref => ref.id));
      for (const id of task?.artifactIds ?? []) ids.add(id);
      for (const message of messages) {
        for (const id of message.contextArtifactIds ?? []) ids.add(id);
        for (const image of message.images ?? []) ids.add(image.artifactId);
      }
      const sources = new Set(messages.flatMap(message => message.sourceMessageId ? [message.sourceMessageId] : []));
      for (const message of s.messages(this.scope.room.id)) {
        if (!sources.has(message.id)) continue;
        for (const id of message.artifactIds) ids.add(id);
        const sourceRun = message.runId ? s.get<Run>('runs', message.runId) : undefined;
        const sourceTask = sourceRun ? s.get<Task>('tasks', sourceRun.taskId) : undefined;
        for (const id of sourceTask?.artifactIds ?? []) ids.add(id);
      }
      for (const artifact of this.artifacts()) {
        if (artifact.source !== referenceIndexSource && ids.has(artifact.id) && await this.readable(artifact)) refs.push(artifactReference(artifact));
      }
    }
    if (this.allowed('get_task')) {
      const ids = new Set([this.scope.task.id, ...previous.filter(ref => ref.kind === 'task').map(ref => ref.id)]);
      for (const id of ids) {
        const task = scopedTask(this.state, this.scope.room, this.scope.bot.id, id);
        if (task) refs.push({ kind: 'task', id: task.id, name: task.goal });
      }
    }
    const important = new Set(messages.flatMap(message => [...message.contextArtifactIds ?? [], ...(message.images ?? []).map(image => image.artifactId)]));
    return refs.sort((a, b) => Number(important.has(b.id)) - Number(important.has(a.id)));
  }

  async preserveToolOutput(message: ModelMessage): Promise<ContextReference | undefined> {
    this.scope.signal.throwIfAborted();
    if (message.role !== 'tool' || !this.allowed('read_artifact')) return;
    const projection = contextProjectionId(this.state, this.scope.task.id, this.scope.runId, message);
    if (projection) {
      const reference = await this.readableArtifact(projection);
      if (reference) this.registerProjection(message, reference);
      return reference;
    }
    const size = Buffer.byteLength(message.content);
    if (!size || size > maxReadableBytes) return;
    const sha256 = createHash('sha256').update(message.content).digest('hex');
    const existing = this.artifacts().find(artifact => artifact.taskId === this.scope.task.id
      && artifact.source === 'context-compaction' && artifact.sha256 === sha256);
    if (existing && await this.readable(existing)) return artifactReference(existing);
    const s = this.state.storage, task = s.get<Task>('tasks', this.scope.task.id);
    if (!task || task.conversationId !== this.scope.room.id || task.botId !== this.scope.bot.id) return;
    const id = randomUUID(), directory = join(this.state.dataDirectory, 'artifacts', id);
    const path = join(directory, 'tool-output.txt');
    const contentSource = this.state.artifactContents.findSource(task.id, message.content, { runId: this.scope.runId, callId: message.callId });
    if (!contentSource) await mkdir(directory, { recursive: true });
    try {
      if (!contentSource) await writeFile(path, message.content, { mode: 0o600 });
      this.scope.signal.throwIfAborted();
      if (!this.allowed('read_artifact')) { await rm(directory, { recursive: true, force: true }); return; }
      const artifact: Artifact = { id, name: '工具完整结果.txt', path, mimeType: 'text/plain', sha256, size,
        taskId: task.id, botId: task.botId, conversationId: task.conversationId, createdAt: new Date().toISOString(),
        source: 'context-compaction', purpose: 'intermediate', ...(contentSource ? { contentSource } : {}) };
      s.transaction(() => {
        const current = s.get<Task>('tasks', task.id)!;
        s.put('artifacts', artifact);
        s.put('tasks', { ...current, artifactIds: [...current.artifactIds, id] });
      });
      this.state.changed();
      return artifactReference(artifact);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async readableArtifact(id: string): Promise<ContextReference | undefined> {
    this.scope.signal.throwIfAborted();
    if (!this.allowed('read_artifact')) return;
    const artifact = this.artifacts().find(artifact => artifact.id === id);
    return artifact && await this.readable(artifact) ? artifactReference(artifact) : undefined;
  }

  isProjection(message: ModelMessage): boolean {
    return !!contextProjectionId(this.state, this.scope.task.id, this.scope.runId, message);
  }

  registerProjection(message: ModelMessage, reference: ContextReference): void {
    registerContextProjection(this.state, this.scope.task.id, message.content, reference.id);
  }

  private readable(artifact: Artifact): Promise<boolean> {
    if (artifact.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return Promise.resolve(false);
    return this.state.artifactContents.canRead(artifact);
  }

  private allowed(name: string): boolean {
    const bot = this.state.storage.get<Bot>('bots', this.scope.bot.id);
    return !!bot && !bot.archived && this.scope.toolNames.includes(name) && bot.toolNames.includes(name);
  }
  private artifacts(): Artifact[] {
    return accessibleArtifacts(this.state, this.scope.room, this.scope.bot.id, this.scope.task);
  }
}

function artifactReference(artifact: Artifact): ContextReference {
  return { kind: 'artifact', id: artifact.id, name: artifact.name };
}
