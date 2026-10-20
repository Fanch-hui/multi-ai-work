import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact } from '../domain/types.js';
import {
  defaultArtifactStoragePolicy,
  type ArtifactStoragePolicy,
} from '../domain/artifact-storage.js';
import { maintainDerivedCache } from '../tools/derived-cache.js';
import type { State } from './state.js';
import type { ArtifactPreviews } from './artifact-preview.js';
import { deleteArtifact } from './artifact-delete.js';
import { ArtifactDrafts } from './artifact-drafts.js';
import { artifactStorageUsage } from './artifact-storage-usage.js';
import { legacyCacheEntries, removeOrphanFiles } from './artifact-storage-gc.js';
import { publicError } from './errors.js';

const policyKey = 'artifact-storage-policy';

export class ArtifactStorage {
  readonly drafts: ArtifactDrafts;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<number>;
  private closed = false;
  private paused = 0;
  private cursor = 0;
  private idle = () => true;

  constructor(
    private state: State,
    private previews: ArtifactPreviews,
  ) {
    this.drafts = new ArtifactDrafts(state);
  }

  policy(): ArtifactStoragePolicy {
    return {
      ...defaultArtifactStoragePolicy,
      ...this.state.storage.metadata<ArtifactStoragePolicy>(policyKey),
    };
  }

  usage() {
    return artifactStorageUsage(this.state, this.drafts, this.policy());
  }

  configure(policy: ArtifactStoragePolicy) {
    this.state.storage.setMetadata(policyKey, policy);
    return this.usage();
  }

  start(idle: () => boolean) {
    this.idle = idle;
    this.schedule(5000);
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending;
  }

  async pause() {
    this.paused++;
    try {
      await this.pending;
    } catch (error) {
      this.paused--;
      throw error;
    }
    return () => this.paused--;
  }

  async clean() {
    const removedBytes = await this.maintain(true);
    return { removedBytes, usage: await this.usage() };
  }

  async maintain(clear = false): Promise<number> {
    if (this.pending) {
      await this.pending;
      if (clear) return this.maintain(true);
      return 0;
    }
    if (this.closed || this.paused || (!clear && !this.idle())) return 0;
    const pending = this.sweep(clear).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      void this.maintain()
        .catch((error) => console.warn('文件存储维护失败：', publicError(error)))
        .finally(() => {
          if (!this.closed) this.schedule(60000);
        });
    }, delay);
    this.timer.unref();
  }

  private async sweep(clear: boolean) {
    if (this.idle()) this.migrate();
    const policy = this.policy();
    let removed = (
      await maintainDerivedCache(join(this.state.dataDirectory, 'derived-cache'), {
        budgetBytes: policy.cacheMiB * 1024 * 1024,
        idleMs: policy.cacheIdleDays * 24 * 60 * 60 * 1000,
        clear,
      })
    ).removedBytes;
    for (const artifact of this.drafts.expired()) {
      if (this.state.artifactContents.isPinned(artifact.id)) continue;
      const linked = this.state.artifactObjects.sharesObject(artifact);
      const result = await deleteArtifact(this.state, artifact.id, this.previews, () =>
        this.drafts.isExpired(artifact.id),
      );
      if (result.ok) {
        const shared =
          artifact.objectHash &&
          this.state.storage
            .all<Artifact>('artifacts')
            .some((other) => other.objectHash === artifact.objectHash);
        if (!linked) removed += artifact.size;
        if (artifact.objectHash && !shared) removed += artifact.size;
      }
    }
    if (this.idle()) removed += await removeOrphanFiles(this.state);
    if (clear) removed += await this.state.artifactContents.clearCache();
    for (const legacy of await legacyCacheEntries(this.state)) {
      if (!clear && legacy.usedAt > Date.now() - policy.cacheIdleDays * 24 * 60 * 60 * 1000)
        continue;
      await rm(legacy.path, { recursive: true, force: true });
      removed += legacy.bytes;
    }
    return removed;
  }

  private migrate() {
    const rows = this.state.storage.db
      .prepare('SELECT rowid,payload FROM artifacts WHERE rowid > ? ORDER BY rowid LIMIT 16')
      .all(this.cursor) as { rowid: number; payload: string }[];
    for (const row of rows) {
      const artifact = JSON.parse(row.payload) as Artifact;
      if (this.state.artifactContents.isPinned(artifact.id)) continue;
      const migrated = this.state.artifactObjects.migrate(artifact);
      if (migrated !== artifact) {
        this.state.storage.put('artifacts', migrated);
        if (migrated.path !== artifact.path) this.state.artifactObjects.releaseRestored(artifact);
      }
      this.cursor = row.rowid;
    }
    if (rows.length < 16) this.cursor = 0;
  }
}
