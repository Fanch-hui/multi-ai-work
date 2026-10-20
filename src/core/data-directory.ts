import Database from 'better-sqlite3';
import { cp, lstat, mkdir, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  relocatePath,
  requireEmptyDirectory,
  validateDataDirectory,
} from './data-directory-paths.js';

const dataEntries = [
  'credentials.enc.json',
  'artifacts',
  'workspace',
  'skills',
  'presets',
  'restored',
  'profiles',
  'runtimes',
  'backups',
];
const pathFields = {
  workspaces: ['path'],
  connections: ['profilePath', 'executable'],
  artifacts: ['path', 'workingPath'],
  skills: ['path', 'resourceRoot'],
  preset_installations: ['directory'],
  tool_connections: ['command'],
} as const;

export async function migrateDataDirectory(source: string, input: string): Promise<string> {
  const { target, roots } = await validateDataDirectory(source, input);
  const parent = dirname(target);
  // Windows rejects recursive mkdir on an existing drive root with EPERM.
  if (parent !== dirname(parent)) await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.multi-ai-work-data-'));
  try {
    for (const name of dataEntries) {
      const path = join(source, name);
      const exists = await lstat(path).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists)
        await cp(path, join(staging, name), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true,
        });
    }
    const original = new Database(join(source, 'team.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await original.backup(join(staging, 'team.sqlite'));
    } finally {
      original.close();
    }
    relocateDatabase(join(staging, 'team.sqlite'), roots, target);
    await requireEmptyDirectory(target);
    await rmdir(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await rename(staging, target);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function relocateDatabase(path: string, roots: string[], target: string) {
  const db = new Database(path, { fileMustExist: true });
  const move = (value: unknown) => relocatePath(value, roots, target);
  try {
    db.transaction(() => {
      for (const [table, fields] of Object.entries(pathFields)) {
        const rows = db.prepare(`SELECT id, payload FROM ${table}`).all() as {
          id: string;
          payload: string;
        }[];
        const update = db.prepare(`UPDATE ${table} SET payload = ? WHERE id = ?`);
        for (const row of rows) {
          const value = JSON.parse(row.payload) as Record<string, unknown>;
          for (const field of fields) if (field in value) value[field] = move(value[field]);
          if (table === 'artifacts' && value.image && typeof value.image === 'object') {
            const image = value.image as Record<string, unknown>;
            image.path = move(image.path);
          }
          if (table === 'tool_connections' && Array.isArray(value.args))
            value.args = value.args.map(move);
          if (JSON.stringify(value) === row.payload) continue;
          if (table === 'connections') value.revision = Number(value.revision ?? 1) + 1;
          update.run(JSON.stringify(value), row.id);
        }
      }
    })();
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('复制的数据无法通过完整性检查');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}
