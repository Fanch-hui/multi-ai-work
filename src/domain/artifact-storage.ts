export interface ArtifactStoragePolicy {
  cacheMiB: number;
  cacheIdleDays: number;
}

export interface ArtifactStorageUsage {
  fileBytes: number;
  logicalFileBytes: number;
  historyBytes: number;
  cacheBytes: number;
  reclaimableBytes: number;
  fileCount: number;
  policy: ArtifactStoragePolicy;
}

export interface ArtifactStorageCleanup {
  removedBytes: number;
  usage: ArtifactStorageUsage;
}

export const defaultArtifactStoragePolicy: ArtifactStoragePolicy = {
  cacheMiB: 512,
  cacheIdleDays: 7,
};
