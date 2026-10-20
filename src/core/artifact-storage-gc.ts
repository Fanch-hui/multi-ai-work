import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { State } from './state.js';
import type { Artifact } from '../domain/types.js';

const day = 24 * 60 * 60 * 1000;
export interface OrphanFile {
  path: string;
  bytes: number;
  objectHash?: string;
  artifactId?: string;
  temporary?: boolean;
}

export async function directoryBytes(path: string): Promise<number> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info || info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let bytes = 0;
  const entries = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) bytes += await directoryBytes(join(path, entry));
  return bytes;
}

export async function orphanFiles(state: State): Promise<OrphanFile[]> {
  const candidates: OrphanFile[] = [];
  for (const kind of ['artifact-objects', 'artifacts', 'artifact-open']) {
    const root = join(state.dataDirectory, kind);
    const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const object = kind === 'artifact-objects';
      const temporary = object && /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name);
      const allowed =
        temporary ||
        (object ? /^[a-f0-9]{64}$/.test(entry.name) : /^[a-f0-9-]{36}$/.test(entry.name));
      if (!allowed) continue;
      if (object ? !entry.isFile() : !entry.isDirectory()) continue;
      const path = join(root, entry.name);
      const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!file || file.isSymbolicLink() || file.mtimeMs >= Date.now() - (object ? day : 7 * day))
        continue;
      const referenced = object
        ? state.storage.db
            .prepare("SELECT 1 FROM artifacts WHERE json_extract(payload, '$.objectHash') = ?")
            .get(entry.name)
        : state.storage.get('artifacts', entry.name);
      if (referenced) continue;
      const candidate: OrphanFile = {
        path,
        bytes: await directoryBytes(path),
      };
      if (temporary) candidate.temporary = true;
      else if (object) candidate.objectHash = entry.name;
      else candidate.artifactId = entry.name;
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function removeOrphanFiles(state: State): Promise<number> {
  let bytes = 0;
  for (const candidate of await orphanFiles(state)) {
    if (candidate.objectHash) {
      if (!state.artifactObjects.removeUnused(candidate.objectHash)) continue;
    } else if (candidate.temporary || !state.storage.get('artifacts', candidate.artifactId!))
      await rm(candidate.path, { recursive: true, force: true });
    else continue;
    bytes += candidate.bytes;
  }
  return bytes;
}

export async function legacyCacheEntries(state: State) {
  const paths = new Set([join(state.dataDirectory, 'artifact-previews')]);
  for (const artifact of state.storage.all<Artifact>('artifacts')) {
    if (!state.artifactObjects.owns(artifact)) continue;
    const directory = join(state.dataDirectory, 'artifacts', artifact.id);
    paths.add(join(directory, '.image'));
    paths.add(join(directory, `${artifact.id}-preview`));
  }
  const entries: { path: string; bytes: number; usedAt: number }[] = [];
  for (const path of paths) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isDirectory() && !info.isSymbolicLink())
      entries.push({ path, bytes: await directoryBytes(path), usedAt: info.mtimeMs });
  }
  return entries;
}
