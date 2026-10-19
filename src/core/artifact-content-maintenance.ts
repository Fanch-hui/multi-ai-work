import { readFile, rm, rmdir, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Artifact } from '../domain/types.js';
import type { ArtifactContents } from './artifact-contents.js';
import {
  artifactContentLookup,
  matchesArtifact,
  sourceContent,
} from './artifact-content-source.js';

export const toolResultCacheIdleMs = 12 * 60 * 60 * 1000;

export class ArtifactContentMaintenance {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private paused = 0;
  private closed = false;
  private cursor = 0;
  private isIdle = () => true;
  private changed = () => {};
  constructor(
    private contents: ArtifactContents,
    private budget: number,
  ) {}

  start(isIdle: () => boolean, changed: () => void) {
    this.isIdle = isIdle;
    this.changed = changed;
    this.schedule(5000);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
  async pause(): Promise<() => void> {
    this.paused++;
    await this.running;
    return () => {
      this.paused--;
    };
  }
  run(): Promise<void> {
    if (this.running) return this.running;
    if (!this.available()) return Promise.resolve();
    const pending = this.sweep().finally(() => {
      if (this.running === pending) this.running = undefined;
    });
    this.running = pending;
    return pending;
  }
  private available() {
    return !this.closed && !this.paused && this.isIdle();
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.run()
        .catch(() => {})
        .finally(() => {
          if (!this.closed) this.schedule(60000);
        });
    }, delay);
    this.timer.unref();
  }

  private async sweep() {
    const { storage } = this.contents;
    const rows = storage.db
      .prepare(
        "SELECT rowid, payload FROM artifacts WHERE rowid > ? AND json_extract(payload, '$.source') = 'context-compaction' ORDER BY rowid LIMIT 16",
      )
      .all(this.cursor) as { rowid: number; payload: string }[];
    let migrated = false;
    for (const row of rows) {
      if (!this.available()) break;
      const artifact = JSON.parse(row.payload) as Artifact;
      if (!artifact.contentSource && artifact.taskId && this.contents.ownsCachePath(artifact)) {
        await this.contents.withPinned(artifact, async () => {
          const previous = await stat(artifact.path).catch(() => undefined);
          if (!previous?.isFile()) return;
          const bytes = await readFile(artifact.path).catch(() => undefined);
          await utimes(artifact.path, previous.atime, previous.mtime).catch(() => {});
          if (!bytes || !matchesArtifact(bytes, artifact)) return;
          const source = this.contents.findSource(artifact.taskId!, bytes.toString('utf8'));
          const current = storage.get<Artifact>('artifacts', artifact.id);
          if (source && current && current.sha256 === artifact.sha256 && !current.contentSource) {
            storage.put('artifacts', { ...current, contentSource: source });
            migrated = true;
          }
        });
      }
      this.cursor = row.rowid;
    }
    if (migrated) this.changed();
    if (!this.available()) return;
    const cached: { artifact: Artifact; size: number; used: number }[] = [];
    const artifacts = storage.db
      .prepare(
        "SELECT payload FROM artifacts WHERE json_extract(payload, '$.contentSource') IS NOT NULL AND json_extract(payload, '$.source') IN ('context-compaction', 'context-reference-index')",
      )
      .all() as { payload: string }[];
    for (const row of artifacts) {
      if (!this.available()) return;
      const artifact = JSON.parse(row.payload) as Artifact;
      if (!this.contents.ownsCachePath(artifact)) continue;
      const info = await stat(artifact.path).catch(() => undefined);
      if (info?.isFile())
        cached.push({ artifact, size: info.size, used: Math.max(info.atimeMs, info.mtimeMs) });
    }
    let total = cached.reduce((sum, item) => sum + item.size, 0);
    const expiredBefore = Date.now() - toolResultCacheIdleMs;
    for (const item of cached.sort((a, b) => a.used - b.used)) {
      if (!this.available() || (total <= this.budget && item.used > expiredBefore)) break;
      if (this.contents.isPinned(item.artifact.id)) continue;
      await this.contents
        .withPinned(item.artifact, async () => {
          const artifact = storage.get<Artifact>('artifacts', item.artifact.id);
          if (!artifact?.contentSource) return;
          const current = await stat(artifact.path).catch(() => undefined);
          if (
            !current ||
            (total <= this.budget && Math.max(current.atimeMs, current.mtimeMs) > expiredBefore)
          )
            return;
          // Only a verified persistent source makes a file an expendable cache.
          const source = sourceContent(artifact.contentSource, artifactContentLookup(storage));
          if (source === undefined || !matchesArtifact(Buffer.from(source), artifact)) return;
          await rm(artifact.path, { force: true });
          await rmdir(dirname(artifact.path)).catch(() => {});
          total -= item.size;
        })
        .catch(() => {});
    }
  }
}
