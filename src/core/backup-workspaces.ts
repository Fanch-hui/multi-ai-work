import type Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings, Workspace } from '../domain/types.js';

export function backupDefaultWorkspace(source: Database.Database): Workspace | undefined {
  const row = source.prepare('SELECT value FROM metadata WHERE key = ?').get('settings') as
    | { value: string }
    | undefined;
  const settings: Settings | undefined = row && JSON.parse(row.value);
  const workspaces = (
    source.prepare('SELECT payload FROM workspaces ORDER BY rowid').all() as {
      payload: string;
    }[]
  ).map((item) => JSON.parse(item.payload) as Workspace);
  if (settings?.defaultWorkspaceId)
    return workspaces.find((workspace) => workspace.id === settings.defaultWorkspaceId);
  // Older stores inserted the built-in directory before user-added projects.
  const first = workspaces[0];
  return first && /(?:^|[/\\])workspace[/\\]*$/.test(first.path) ? first : undefined;
}

export function restoreWorkingPath(
  path: string | undefined,
  source: Workspace | undefined,
  dataDirectory: string,
): string | undefined {
  if (!path || !source) return path;
  const normalized = path.replaceAll('\\', '/');
  const root = source.path.replaceAll('\\', '/').replace(/\/+$/, '');
  const insensitive = /^[a-z]:\//i.test(root);
  const comparable = insensitive ? normalized.toLowerCase() : normalized;
  const prefix = insensitive ? root.toLowerCase() : root;
  if (comparable !== prefix && !comparable.startsWith(`${prefix}/`)) return path;
  return join(
    realpathSync(join(dataDirectory, 'workspace')),
    ...normalized.slice(root.length).split('/'),
  );
}
