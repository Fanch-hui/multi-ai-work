import { mkdir, copyFile, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute, extname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  Artifact,
  Connection,
  SessionBinding,
  Skill,
  Task,
  ToolConnection,
} from '../domain/types.js';
import type { PresetInstallation } from '../domain/market.js';
import { State, id, now } from './state.js';
import { entityTables } from './storage.js';
import { projectStreamMessage } from './message-stream.js';
import {
  backupFile,
  collectBackupResources,
  restoreBackupResources,
  type BackupResource,
  type RestoredResources,
} from './backup-resources.js';
import { rebuildMemorySearch } from './memory-storage.js';
import { readArtifactBytes } from './artifact-content-source.js';

interface BackupManifest {
  version: 1 | 2;
  artifacts: { id: string; file: string }[];
  databaseSha256?: string;
  resources?: BackupResource[];
}

export class BackupService {
  constructor(private state: State) {}
  async create() {
    const resume = await this.state.artifactContents.pauseMaintenance();
    try {
      return await this.createBackup();
    } finally {
      resume();
    }
  }
  private async createBackup() {
    const directory = join(
      this.state.dataDirectory,
      'backups',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${id()}`,
    );
    await mkdir(join(directory, 'artifacts'), { recursive: true });
    await this.state.storage.backup(join(directory, 'team.sqlite'));
    const records: { id: string; file: string }[] = [];
    const snapshot = new Database(join(directory, 'team.sqlite'), { readonly: true });
    let resources: BackupResource[] = [];
    try {
      const operation = snapshot.prepare('SELECT payload FROM tool_operations WHERE id = ?');
      const text = snapshot.prepare('SELECT value FROM metadata WHERE key = ?');
      const lookup = {
        operation: (operationId: string) => {
          const row = operation.get(operationId) as { payload: string } | undefined;
          return row ? JSON.parse(row.payload) : undefined;
        },
        text: (key: string) => {
          const row = text.get(key) as { value: string } | undefined;
          return row ? JSON.parse(row.value) : undefined;
        },
      };
      const rows = snapshot.prepare('SELECT payload FROM artifacts').all() as { payload: string }[];
      for (const row of rows) {
        const artifact = JSON.parse(row.payload) as Artifact;
        const file = `artifacts/${artifact.id}`;
        await this.state.artifactContents.withPinned(artifact, async () => {
          if (artifact.contentSource)
            await writeFile(join(directory, file), await readArtifactBytes(artifact, lookup));
          else await copyFile(artifact.path, join(directory, file));
        });
        records.push({ id: artifact.id, file });
      }
      resources = await collectBackupResources(snapshot, this.state.dataDirectory, directory);
    } catch (error) {
      snapshot.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      if (snapshot.open) snapshot.close();
    }
    const databaseSha256 = createHash('sha256')
      .update(await readFile(join(directory, 'team.sqlite')))
      .digest('hex');
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(
        { version: 2, createdAt: now(), databaseSha256, artifacts: records, resources },
        null,
        2,
      ),
    );
    return { path: directory };
  }
  async restore(path: string) {
    const resume = await this.state.artifactContents.pauseMaintenance();
    try {
      return await this.restoreBackup(path);
    } finally {
      resume();
    }
  }
  private async restoreBackup(path: string) {
    if (!isAbsolute(path)) throw new Error('备份路径必须为绝对路径');
    const root = await realpath(path);
    const manifest = JSON.parse(
      await readFile(await backupFile(root, 'manifest.json'), 'utf8'),
    ) as BackupManifest;
    if (
      ![1, 2].includes(manifest.version) ||
      !Array.isArray(manifest.artifacts) ||
      (manifest.version === 2 && !Array.isArray(manifest.resources))
    )
      throw new Error('备份格式不支持');
    const databasePath = await backupFile(root, 'team.sqlite');
    if (
      manifest.version === 2 &&
      createHash('sha256')
        .update(await readFile(databasePath))
        .digest('hex') !== manifest.databaseSha256
    )
      throw new Error('备份数据库校验失败');
    const source = new Database(databasePath, { readonly: true });
    const restoreDirectory = join(this.state.dataDirectory, 'restored', id());
    await mkdir(restoreDirectory, { recursive: true });
    const paths = new Map<string, string>();
    const hostId = this.state.storage.metadata('oauth.hostId');
    try {
      if (source.pragma('user_version', { simple: true }) !== 1)
        throw new Error('备份数据库版本不兼容');
      const resources = await restoreBackupResources(
        root,
        restoreDirectory,
        manifest.resources ?? [],
      );
      for (const record of manifest.artifacts) {
        const file = await backupFile(
          root,
          manifest.version === 1 ? record.file.replaceAll('\\', '/') : record.file,
        );
        const row = source.prepare('SELECT payload FROM artifacts WHERE id = ?').get(record.id) as
          | { payload: string }
          | undefined;
        if (!row) throw new Error('备份成果校验失败');
        const artifact = JSON.parse(row.payload) as Artifact,
          bytes = await readFile(file);
        if (
          bytes.length !== artifact.size ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
        )
          throw new Error('备份成果校验失败');
        const destination = join(restoreDirectory, `${id()}${extname(artifact.name)}`);
        await writeFile(destination, bytes);
        paths.set(record.id, destination);
      }
      const hasStreamCursor = (
        source.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
      ).some((column) => column.name === 'stream_sequence');
      const db = this.state.storage.db;
      db.transaction(() => {
        for (const table of [...entityTables, 'metadata', 'messages', 'run_events']) {
          let columns: string[];
          if (table === 'metadata') {
            columns = ['key', 'value'];
          } else if (table === 'messages') {
            columns = [
              'id',
              'conversation_id',
              'sequence',
              'payload',
              ...(hasStreamCursor ? ['stream_sequence'] : []),
            ];
          } else if (table === 'run_events') {
            columns = ['id', 'run_id', 'payload'];
          } else {
            columns = ['id', 'payload'];
          }
          const optional =
            [
              'memory_revisions',
              'memory_usage',
              'compactions',
              'provider_archive',
              'managed_progress_deltas',
              'questions',
              'processes',
              'preset_installations',
              'task_plans',
            ].includes(table) &&
            !source.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table);
          const rows = optional
            ? []
            : (source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all() as Record<
                string,
                unknown
              >[]);
          db.exec(`DELETE FROM ${table}`);
          if (table === 'managed_progress_deltas') continue;
          for (const row of rows) {
            if (table === 'messages' && hasStreamCursor) {
              const projected = projectStreamMessage(source, {
                payload: row.payload as string,
                stream_sequence: row.stream_sequence as number,
              });
              row.payload = JSON.stringify(projected.message);
              row.stream_sequence = projected.sequence;
            }
            if (typeof row.payload === 'string')
              row.payload = this.sanitize(table, row.payload, paths, resources);
            db.prepare(
              `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            ).run(...Object.values(row));
          }
        }
        rebuildMemorySearch(this.state.storage);
        db.prepare(
          "DELETE FROM metadata WHERE key LIKE 'history:%' OR key LIKE 'history-validity:%' OR key LIKE 'results:%'",
        ).run();
        if (hostId) this.state.storage.setMetadata('oauth.hostId', hostId);
      })();
    } catch (error) {
      await rm(restoreDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      this.state.storage.invalidateTables();
      source.close();
    }
    this.state.changed();
    return { restored: true, path: root };
  }
  private sanitize(
    table: string,
    payload: string,
    paths: Map<string, string>,
    resources: RestoredResources,
  ): string {
    const value = JSON.parse(payload);
    if (table === 'artifacts') {
      delete value.image;
      const artifact = value as Artifact;
      const path = paths.get(artifact.id);
      if (!path) throw new Error('备份缺少成果文件');
      artifact.path = path;
      artifact.workingPath = undefined;
      delete artifact.objectHash;
      delete artifact.contentSource;
    }
    if (table === 'connections') {
      const connection = value as Connection;
      connection.status = 'untested';
      connection.secretRef = undefined;
    }
    if (table === 'tool_connections') {
      const connection = value as ToolConnection;
      connection.status = 'untested';
      connection.secretRef = undefined;
    }
    if (table === 'skills' && !value.bundled) {
      const skill = value as Skill,
        restored = resources.skills.get(skill.id);
      if (restored) Object.assign(skill, restored, { missing: false });
      else {
        skill.missing = true;
        skill.path = '';
        skill.resourceRoot = undefined;
      }
    }
    if (table === 'preset_installations') {
      const installation = value as PresetInstallation;
      installation.directory = resources.installations.get(installation.id);
      if (installation.status === 'downloading') {
        installation.status = 'failed';
        installation.error = '下载在备份恢复后需要重试';
        installation.progress = 0;
      } else if (
        installation.status === 'installed' &&
        (!installation.directory ||
          installation.skillIds.some((skillId) => !resources.skills.has(skillId)))
      ) {
        installation.status = 'missing';
        installation.error = '备份缺少预设或技能资源，请重新下载';
      }
    }
    if (table === 'session_bindings') {
      const binding = value as SessionBinding;
      binding.nativeSessionId = undefined;
      binding.lastDeliveredSequence = 0;
      binding.generation++;
    }
    if (
      table === 'tasks' &&
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)
    ) {
      const task = value as Task;
      task.status = 'interrupted';
      task.error = '从备份恢复，请重新确认账号与工作目录后继续。';
    }
    if (table === 'tasks') {
      value.recovery = undefined;
      value.resumeFromRunId = undefined;
    }
    if (table === 'provider_archive') delete value.checkpoint;
    if (table === 'approvals' && value.status === 'pending') value.status = 'rejected';
    if (table === 'questions' && value.status === 'pending') value.status = 'cancelled';
    if (table === 'processes' && value.status === 'running') value.status = 'unknown';
    if (table === 'runs' && ['running', 'waiting_approval', 'waiting_input'].includes(value.status))
      value.status = 'interrupted';
    if (table === 'messages' && value.status === 'draft') value.status = 'interrupted';
    if (table === 'deliveries' && value.kind === 'user-input' && value.status === 'claimed') {
      value.status = 'pending';
      value.runId = undefined;
    }
    return JSON.stringify(value);
  }
}
