import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact } from '../domain/types.js';
import type { State } from './state.js';
import type { ArtifactPreviews } from './artifact-preview.js';
import { required } from './errors.js';

export async function deleteArtifact(
  state: State,
  artifactId: string,
  previews: ArtifactPreviews,
  eligible?: () => boolean,
) {
  const stored = state.storage.get<Artifact>('artifacts', artifactId);
  if (eligible && !stored) return { ok: false };
  const artifact = required(stored, '成果不存在');
  const removed = await state.artifactContents.remove(artifact, async () => {
    await previews.remove(artifactId);
    if (eligible) {
      if (state.artifactContents.isOpened(artifactId) || !eligible()) return false;
      // Invalidate the record synchronously with the lease/reference check, before filesystem awaits.
      forgetArtifact(state, artifactId);
      state.changed();
    }
    const directory = path.resolve(state.dataDirectory, 'artifacts', artifact.id);
    if (state.artifactObjects.owns(artifact)) await rm(directory, { recursive: true, force: true });
    else await removeRestoredCopy(state.dataDirectory, artifact);
    if (!eligible) forgetArtifact(state, artifactId);
    if (artifact.objectHash) state.artifactObjects.removeUnused(artifact.objectHash);
  });
  if (removed && !eligible) state.changed();
  return { ok: removed };
}

function forgetArtifact(state: State, artifactId: string) {
  state.storage.transaction(() => {
    state.storage.delete('artifacts', artifactId);
    state.storage.db
      .prepare('DELETE FROM metadata WHERE key = ?')
      .run(`artifact-draft:${artifactId}`);
  });
}

async function removeRestoredCopy(dataDirectory: string, artifact: Artifact) {
  const file = path.resolve(artifact.path),
    batch = path.dirname(file);
  if (path.dirname(batch) !== path.resolve(dataDirectory, 'restored')) return;
  const actualBatch = await realpath(batch).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (actualBatch !== path.join(await realpath(dataDirectory), 'restored', path.basename(batch)))
    return;
  await rm(file, { force: true });
  const preview = path.join(batch, `${artifact.id}-preview`);
  if (path.dirname(preview) === batch) await rm(preview, { recursive: true, force: true });
}
