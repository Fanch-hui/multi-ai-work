import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Artifact, Task } from '../domain/types.js';
import type { ArtifactStoragePolicy, ArtifactStorageUsage } from '../domain/artifact-storage.js';
import { isDeliverableArtifact } from '../domain/artifact-purpose.js';
import { latestArtifactVersions } from '../domain/artifact-versions.js';
import { measureDerivedCache } from '../tools/derived-cache.js';
import type { State } from './state.js';
import type { ArtifactDrafts } from './artifact-drafts.js';
import { legacyCacheEntries, orphanFiles } from './artifact-storage-gc.js';

export async function artifactStorageUsage(
  state: State,
  drafts: ArtifactDrafts,
  policy: ArtifactStoragePolicy,
): Promise<ArtifactStorageUsage> {
  const artifacts = state.storage.all<Artifact>('artifacts');
  const current = latestArtifactVersions(
    artifacts.filter(isDeliverableArtifact),
    new Map(state.storage.all<Task>('tasks').map((task) => [task.id, task])),
  );
  const currentHashes = new Set(current.map((artifact) => artifact.sha256));
  const currentIds = new Set(current.map((artifact) => artifact.id));
  const histories = new Map<string, number>();
  const inodes = new Set<string>();
  let fileBytes = 0;
  let logicalFileBytes = 0;
  for (const artifact of artifacts) {
    if (artifact.contentSource) continue;
    logicalFileBytes += artifact.size;
    const info = await lstat(artifact.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isFile()) {
      const inode = `${info.dev}:${info.ino}`;
      if (!inodes.has(inode)) fileBytes += info.size;
      inodes.add(inode);
    }
    if (artifact.objectHash) {
      const object = await lstat(join(state.artifactObjects.root, artifact.objectHash)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (object?.isFile()) {
        const objectInode = `${object.dev}:${object.ino}`;
        if (!inodes.has(objectInode)) fileBytes += object.size;
        inodes.add(objectInode);
      }
    }
    if (
      isDeliverableArtifact(artifact) &&
      !currentIds.has(artifact.id) &&
      !currentHashes.has(artifact.sha256)
    )
      histories.set(artifact.sha256, artifact.size);
  }
  const [derived, legacy, orphans, toolCache] = await Promise.all([
    measureDerivedCache(join(state.dataDirectory, 'derived-cache')),
    legacyCacheEntries(state),
    orphanFiles(state),
    state.artifactContents.cachedBytes(),
  ]);
  const cacheBytes = derived + legacy.reduce((sum, entry) => sum + entry.bytes, 0) + toolCache;
  const expired = drafts.expired();
  const expiredIds = new Set(expired.map((artifact) => artifact.id));
  const retainedHashes = new Set(
    artifacts
      .filter((artifact) => !expiredIds.has(artifact.id))
      .map((artifact) => artifact.objectHash),
  );
  const abandonedContents = new Map<string, number>();
  for (const artifact of expired) {
    if (artifact.objectHash && retainedHashes.has(artifact.objectHash)) continue;
    abandonedContents.set(artifact.objectHash ?? artifact.id, artifact.size);
  }
  const abandoned = [...abandonedContents.values()].reduce((sum, bytes) => sum + bytes, 0);
  return {
    fileBytes,
    logicalFileBytes,
    historyBytes: [...histories.values()].reduce((sum, bytes) => sum + bytes, 0),
    cacheBytes,
    reclaimableBytes: cacheBytes + orphans.reduce((sum, file) => sum + file.bytes, 0) + abandoned,
    fileCount: artifacts.length,
    policy,
  };
}
