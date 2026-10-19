import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact } from '../domain/types.js';
import type { State } from './state.js';
import type { ArtifactPreviews } from './artifact-preview.js';
import { required } from './errors.js';

export async function deleteArtifact(state: State, artifactId: string, previews: ArtifactPreviews) {
  const artifact = required(state.storage.get<Artifact>('artifacts', artifactId), '成果不存在');
  await state.artifactContents.remove(artifact, async () => {
    await previews.remove(artifactId);
    const directory = path.resolve(state.dataDirectory, 'artifacts', artifact.id);
    const root = path.resolve(state.dataDirectory, 'artifacts');
    if (path.dirname(directory) === root && path.dirname(path.resolve(artifact.path)) === directory)
      await rm(directory, { recursive: true, force: true });
    else await removeRestoredCopy(state.dataDirectory, artifact);
    state.storage.delete('artifacts', artifactId);
  });
  state.changed();
  return { ok: true };
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
