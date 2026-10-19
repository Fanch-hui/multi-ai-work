import type { AppUpdateManifest } from '../../src/domain/app-update.js';
export function createReleaseManifest(
  directory: string,
  version: string,
): Promise<AppUpdateManifest>;
export function writeReleaseMetadata(
  directory: string,
  version: string,
): Promise<AppUpdateManifest>;
