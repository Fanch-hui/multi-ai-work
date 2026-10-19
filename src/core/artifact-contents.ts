import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Artifact, Run, Task } from '../domain/types.js';
import type { Storage } from './storage.js';
import {
  artifactContentLookup,
  findArtifactContentSource,
  matchesArtifact,
  maxArtifactBytes,
  readArtifactBytes,
} from './artifact-content-source.js';
import { ArtifactContentMaintenance } from './artifact-content-maintenance.js';

export const toolResultCacheBytes = 128 * 1024 * 1024;
export { toolResultCacheIdleMs } from './artifact-content-maintenance.js';

export class ArtifactContents {
  private locks = new Map<string, Promise<unknown>>();
  private opened = new Set<string>();
  private maintenance: ArtifactContentMaintenance;
  constructor(
    readonly storage: Storage,
    readonly dataDirectory: string,
    cacheBytes = toolResultCacheBytes,
  ) {
    this.maintenance = new ArtifactContentMaintenance(this, cacheBytes);
  }

  start(isIdle: () => boolean, changed: () => void) {
    this.maintenance.start(isIdle, changed);
  }
  async close() {
    await this.maintenance.close();
    await Promise.allSettled([...this.locks.values()]);
  }
  maintain() {
    return this.maintenance.run();
  }
  pauseMaintenance() {
    return this.maintenance.pause();
  }
  findSource(taskId: string, content: string, hint?: { runId?: string; callId?: string }) {
    return findArtifactContentSource(this.storage, taskId, content, hint);
  }
  isPinned(id: string) {
    return this.opened.has(id) || this.locks.has(id);
  }
  ownsCachePath(artifact: Artifact) {
    return (
      dirname(resolve(artifact.path)) === resolve(this.dataDirectory, 'artifacts', artifact.id)
    );
  }

  async withPinned<T>(artifact: Artifact, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(artifact.id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    this.locks.set(artifact.id, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(artifact.id) === pending) this.locks.delete(artifact.id);
    }
  }

  async read(artifact: Artifact): Promise<Buffer> {
    return this.withPinned(artifact, async () => {
      const current = this.current(artifact);
      const bytes = await readArtifactBytes(current, artifactContentLookup(this.storage));
      if (current.contentSource && this.ownsCachePath(current))
        await utimes(current.path, new Date(), new Date()).catch(() => {});
      return bytes;
    });
  }
  async canRead(artifact: Artifact): Promise<boolean> {
    try {
      return await this.withPinned(artifact, async () => {
        const current = this.current(artifact);
        if (current.contentSource)
          return (
            (await readArtifactBytes(current, artifactContentLookup(this.storage))).length <=
            maxArtifactBytes
          );
        const info = await stat(current.path);
        await access(current.path, constants.R_OK);
        return info.isFile() && info.size <= maxArtifactBytes;
      });
    } catch {
      return false;
    }
  }

  async materialize(artifact: Artifact, keepOpen = false): Promise<string> {
    return this.withPinned(artifact, async () => {
      const current = this.current(artifact);
      if (!current.contentSource) return current.path;
      await this.write(
        current,
        await readArtifactBytes(current, artifactContentLookup(this.storage)),
      );
      if (keepOpen) this.opened.add(current.id);
      await utimes(current.path, new Date(), new Date());
      return current.path;
    });
  }

  async retainConversation(conversationId: string): Promise<void> {
    const taskIds = new Set(
      this.storage.byField<Task>('tasks', 'conversationId', conversationId).map((task) => task.id),
    );
    const runIds = new Set(
      this.storage
        .all<Run>('runs')
        .filter((run) => taskIds.has(run.taskId))
        .map((run) => run.id),
    );
    for (const artifact of this.storage.all<Artifact>('artifacts')) {
      if (artifact.contentSource?.kind !== 'tool-operation') continue;
      const operation = this.storage.get<{ runId: string }>(
        'tool_operations',
        artifact.contentSource.operationId,
      );
      if (artifact.conversationId !== conversationId && !runIds.has(operation?.runId ?? ''))
        continue;
      await this.withPinned(artifact, async () => {
        const current = this.storage.get<Artifact>('artifacts', artifact.id);
        if (!current?.contentSource) return;
        const bytes = await readArtifactBytes(current, artifactContentLookup(this.storage));
        await this.write(current, bytes);
        this.storage.put('artifacts', { ...current, contentSource: undefined });
      });
    }
  }

  async remove(artifact: Artifact, action: () => Promise<void>) {
    await this.withPinned(artifact, async () => {
      await action();
      if (
        artifact.contentSource?.kind === 'stored-text' &&
        artifact.contentSource.key === `artifact-text:${artifact.id}`
      )
        this.storage.db
          .prepare('DELETE FROM metadata WHERE key = ?')
          .run(artifact.contentSource.key);
      this.opened.delete(artifact.id);
    });
  }

  private current(artifact: Artifact) {
    const current = this.storage.get<Artifact>('artifacts', artifact.id);
    if (!current) throw new Error('成果不存在');
    return current;
  }
  private async write(artifact: Artifact, bytes: Buffer) {
    if (!matchesArtifact(bytes, artifact)) throw new Error('完整工具结果校验失败');
    const existing = await readFile(artifact.path).catch(() => undefined);
    if (existing && matchesArtifact(existing, artifact)) return;
    if (!this.ownsCachePath(artifact)) throw new Error('工具资料缓存路径无效');
    await mkdir(dirname(artifact.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(artifact.path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flush: true });
      await rename(temporary, artifact.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
