import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/core/storage.js';
import { migrateDataDirectory } from '../src/core/data-directory.js';
import { readDataDirectory, saveDataDirectory } from '../apps/desktop/data-location.js';
import type { Artifact, Connection, Skill, Workspace } from '../src/domain/types.js';

const temporary: string[] = [];
const databases: Storage[] = [];
const at = '2026-10-16T12:00:00Z';
const ciphertext = '{"fixture-reference":"opaque-encrypted-fixture"}';
const directories = [
  'artifacts',
  'workspace',
  'skills',
  'presets',
  'restored',
  'profiles',
  'runtimes',
  'backups',
];

afterEach(async () => {
  for (const storage of databases.splice(0)) if (storage.db.open) storage.close();
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function open(directory: string) {
  const storage = new Storage(join(directory, 'team.sqlite'));
  databases.push(storage);
  return storage;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-data-directory-')));
  temporary.push(root);
  const source = join(root, 'original'),
    target = join(root, 'relocated');
  await mkdir(source);
  const storage = open(source);
  for (const directory of directories) {
    await mkdir(join(source, directory));
    await writeFile(join(source, directory, 'fixture.txt'), directory);
  }
  await writeFile(join(source, 'credentials.enc.json'), ciphertext);
  storage.put<Workspace>('workspaces', {
    id: 'internal',
    name: '默认工作区',
    path: join(source, 'workspace'),
    writable: true,
  });
  storage.put<Workspace>('workspaces', {
    id: 'external',
    name: '外部工作区',
    path: join(root, 'external'),
    writable: true,
  });
  storage.put<Connection>('connections', {
    id: 'native',
    name: '原生模型',
    provider: 'antigravity',
    concurrency: 1,
    profilePath: join(source, 'profiles'),
    executable: join(source, 'runtimes', 'fixture.txt'),
    revision: 3,
    status: 'ready',
    models: [],
    secretRef: 'fixture-reference',
    accountScope: 'fixture-scope',
    createdAt: at,
  });
  storage.put<Artifact>('artifacts', {
    id: 'file',
    name: '材料',
    path: join(source, 'artifacts', 'fixture.txt'),
    workingPath: join(source, 'workspace', 'fixture.txt'),
    mimeType: 'text/plain',
    size: 9,
    sha256: 'fixture-digest',
    conversationId: 'room',
    createdAt: at,
    image: {
      path: join(source, 'artifacts', 'fixture.txt'),
      mimeType: 'image/png',
      width: 1,
      height: 1,
    },
  });
  storage.put<Skill>('skills', {
    id: 'reading',
    name: '阅读',
    path: join(source, 'skills', 'fixture.txt'),
    resourceRoot: join(source, 'skills'),
    content: `保留原始说明 ${source}`,
  });
  storage.put('preset_installations', { id: 'preset', directory: join(source, 'presets') });
  const message = storage.appendMessage({
    id: 'message',
    conversationId: 'room',
    authorType: 'user',
    content: `原始消息引用 ${source}`,
    artifactIds: ['file'],
    status: 'committed',
    createdAt: at,
  });
  const archive = {
    id: 'archive',
    bindingId: 'binding',
    message: { content: `原始协议 ${source}` },
  };
  storage.put('provider_archive', archive);
  storage.setMetadata('oauth.hostId', 'fixture-host');
  storage.close();
  return { root, source, target, message, archive };
}

describe('数据目录迁移', () => {
  it.skipIf(process.platform !== 'win32')('迁移至磁盘根目录下的空文件夹', async () => {
    const { source, message } = await fixture();
    const target = await mkdtemp(join(parse(source).root, 'maw-data-migration-test-'));
    temporary.push(target);
    expect(await migrateDataDirectory(source, target)).toBe(target);
    expect(open(target).getMessage('message')).toEqual(message);
    expect(open(source).getMessage('message')).toEqual(message);
  });

  it.each([false, true])(
    '迁移至新目录或空目录（已存在：%s）并保留实际数据与关联',
    async (existing) => {
      const { root, source, target, message, archive } = await fixture();
      if (existing) await mkdir(target);
      expect(await migrateDataDirectory(source, target)).toBe(target);
      const migrated = open(target),
        original = open(source);
      expect(migrated.get<Workspace>('workspaces', 'internal')?.path).toBe(
        join(target, 'workspace'),
      );
      expect(migrated.get<Workspace>('workspaces', 'external')?.path).toBe(join(root, 'external'));
      expect(migrated.get<Artifact>('artifacts', 'file')).toMatchObject({
        id: 'file',
        path: join(target, 'artifacts', 'fixture.txt'),
        workingPath: join(target, 'workspace', 'fixture.txt'),
        image: { path: join(target, 'artifacts', 'fixture.txt') },
      });
      expect(migrated.get<Skill>('skills', 'reading')).toMatchObject({
        path: join(target, 'skills', 'fixture.txt'),
        resourceRoot: join(target, 'skills'),
        content: `保留原始说明 ${source}`,
      });
      expect(migrated.get('preset_installations', 'preset')).toMatchObject({
        directory: join(target, 'presets'),
      });
      expect(migrated.get<Connection>('connections', 'native')).toMatchObject({
        revision: 4,
        profilePath: join(target, 'profiles'),
        executable: join(target, 'runtimes', 'fixture.txt'),
        status: 'ready',
        secretRef: 'fixture-reference',
        accountScope: 'fixture-scope',
      });
      expect(migrated.getMessage('message')).toEqual(message);
      expect(migrated.get('provider_archive', 'archive')).toEqual(archive);
      expect(migrated.metadata('oauth.hostId')).toBe('fixture-host');
      expect(original.get<Workspace>('workspaces', 'internal')?.path).toBe(
        join(source, 'workspace'),
      );
      expect(original.get<Connection>('connections', 'native')?.revision).toBe(3);
      expect(original.getMessage('message')).toEqual(message);
      expect(await readFile(join(target, 'credentials.enc.json'), 'utf8')).toBe(ciphertext);
      expect(await readFile(join(source, 'credentials.enc.json'), 'utf8')).toBe(ciphertext);
      for (const directory of directories)
        expect(await readFile(join(target, directory, 'fixture.txt'), 'utf8')).toBe(directory);
    },
  );

  it('拒绝非空目标、原目录及上下级目录，保留原数据和目标现有文件', async () => {
    const { root, source, target, message } = await fixture();
    await mkdir(target);
    await writeFile(join(target, 'existing.txt'), '用户已有文件');
    for (const directory of [target, source, join(source, 'nested'), root]) {
      await expect(migrateDataDirectory(source, directory)).rejects.toThrow();
    }
    expect(await readFile(join(target, 'existing.txt'), 'utf8')).toBe('用户已有文件');
    expect(open(source).getMessage('message')).toEqual(message);
    expect(await readFile(join(source, 'credentials.enc.json'), 'utf8')).toBe(ciphertext);
  });
});

describe('数据目录启动配置', () => {
  it('默认使用原位置，保存后重读新位置，目标丢失时明确失败', async () => {
    const { root, source, target } = await fixture();
    const defaultDirectory = join(root, 'desktop-settings');
    await mkdir(defaultDirectory);
    expect(await readDataDirectory(defaultDirectory)).toBe(defaultDirectory);
    await migrateDataDirectory(source, target);
    await saveDataDirectory(defaultDirectory, target);
    expect(await readDataDirectory(defaultDirectory)).toBe(target);
    await rm(join(target, 'team.sqlite'));
    await expect(readDataDirectory(defaultDirectory)).rejects.toThrow('数据目录');
    await rm(target, { recursive: true });
    await expect(readDataDirectory(defaultDirectory)).rejects.toThrow('数据目录');
    expect(open(source).getMessage('message')?.id).toBe('message');
  });
});
