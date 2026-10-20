import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Artifact } from '../domain/types.js';
import type { Storage } from './storage.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class ArtifactObjects {
  readonly root: string;

  constructor(
    readonly dataDirectory: string,
    private storage: Storage,
  ) {
    this.root = join(dataDirectory, 'artifact-objects');
  }

  publish(artifactId: string, name: string, bytes: Buffer) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(artifactId)) throw new Error('文件标识无效');
    if (basename(name) !== name || !name || name === '.' || name === '..' || name.includes('\\'))
      throw new Error('文件名称无效');
    const hash = digest(bytes);
    const object = join(this.root, hash);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('文件存储目录无效');
    if (existsSync(object)) {
      if (!lstatSync(object).isFile() || digest(readFileSync(object)) !== hash)
        throw new Error('文件内容存储校验失败');
    } else {
      const temporary = join(this.root, `${hash}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, object);
        chmodSync(object, 0o400);
      } finally {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      }
    }
    const aliases = join(this.dataDirectory, 'artifacts');
    mkdirSync(aliases, { recursive: true, mode: 0o700 });
    if (lstatSync(aliases).isSymbolicLink()) throw new Error('文件存储目录无效');
    const directory = join(aliases, artifactId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('文件存储目录无效');
    const path = join(directory, name);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      try {
        linkSync(object, temporary);
      } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        copyFileSync(object, temporary);
      }
      if (existsSync(path)) chmodSync(path, 0o600);
      renameSync(temporary, path);
      chmodSync(object, 0o400);
      chmodSync(path, 0o400);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
    return { path, objectHash: hash, sha256: hash, size: bytes.length };
  }

  migrate(artifact: Artifact): Artifact {
    if (
      artifact.objectHash ||
      artifact.contentSource ||
      artifact.source === 'context-compaction' ||
      artifact.source === 'context-reference-index' ||
      (!this.owns(artifact) && !this.ownsRestored(artifact))
    )
      return artifact;
    const file = lstatSync(artifact.path, { throwIfNoEntry: false });
    if (!file?.isFile()) return artifact;
    const bytes = readFileSync(artifact.path);
    if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) return artifact;
    return { ...artifact, ...this.publish(artifact.id, artifact.name, bytes) };
  }

  owns(artifact: Artifact): boolean {
    const root = resolve(this.dataDirectory, 'artifacts');
    const directory = resolve(root, artifact.id);
    return (
      dirname(directory) === root &&
      dirname(resolve(artifact.path)) === directory &&
      !lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink() &&
      !lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()
    );
  }

  private ownsRestored(artifact: Artifact): boolean {
    const batch = dirname(resolve(artifact.path));
    return (
      dirname(batch) === resolve(this.dataDirectory, 'restored') &&
      /^[a-f0-9-]{36}$/.test(basename(batch)) &&
      !lstatSync(dirname(batch), { throwIfNoEntry: false })?.isSymbolicLink() &&
      !lstatSync(batch, { throwIfNoEntry: false })?.isSymbolicLink()
    );
  }

  releaseRestored(artifact: Artifact) {
    if (!this.ownsRestored(artifact)) return;
    rmSync(artifact.path, { force: true });
  }

  removeUnused(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    const referenced = this.storage.db
      .prepare("SELECT 1 FROM artifacts WHERE json_extract(payload, '$.objectHash') = ? LIMIT 1")
      .get(hash);
    const object = join(this.root, hash);
    const file = lstatSync(object, { throwIfNoEntry: false });
    if (referenced) {
      // Windows may clear the shared inode's read-only attribute while unlinking an alias.
      if (file?.isFile()) chmodSync(object, 0o400);
      return false;
    }
    if (file?.isFile()) {
      chmodSync(object, 0o600);
      rmSync(object, { force: true });
      return true;
    }
    return false;
  }

  sharesObject(artifact: Artifact): boolean {
    if (!artifact.objectHash) return false;
    const object = join(this.root, artifact.objectHash);
    const source = statSync(artifact.path, { throwIfNoEntry: false });
    const canonical = statSync(object, { throwIfNoEntry: false });
    return !!source && !!canonical && source.dev === canonical.dev && source.ino === canonical.ino;
  }
}
