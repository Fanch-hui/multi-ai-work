import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { BackupService } from '../src/core/backup.js';
import { State } from '../src/core/state.js';
import type { Skill } from '../src/domain/types.js';
import type { PresetInstallation } from '../src/domain/market.js';

const resources: { state: State; root: string }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.state.storage.db.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ai-backup-resources-')),
    state = new State(root);
  resources.push({ state, root });
  const directory = join(root, 'skills', 'shared');
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '---\nname: Reading\n---\nRead supplied material.');
  await writeFile(join(directory, 'scripts', 'read.py'), 'print("restored script")');
  const skill: Skill = {
    id: 'skill-one',
    name: 'Reading',
    path: join(directory, 'SKILL.md'),
    content: 'Read supplied material.',
    resourceRoot: directory,
    digest: 'fixed-digest',
  };
  state.storage.put('skills', skill);
  return { state, root, directory, skill, backup: new BackupService(state) };
}
function installation(directory: string): PresetInstallation {
  return {
    id: 'installed-one',
    source: 'local',
    status: 'installed',
    progress: 100,
    directory,
    skillIds: ['skill-one'],
    createdAt: new Date().toISOString(),
    preset: {
      id: 'reader',
      name: '阅读助理',
      role: '材料阅读',
      version: '1',
      description: '读取材料',
      professions: ['student'],
      rank: 1,
      instructions: '读取技能',
      examples: [],
      outputs: [],
      dependencies: [],
      skills: [],
      platforms: ['darwin', 'win32', 'linux'],
      license: 'MIT',
      releaseNotes: '',
    },
  };
}

describe('技能与预设备份', () => {
  it('保存共享技能资源与预设包，恢复后路径重新映射且可以再次备份', async () => {
    const { state, root, directory, skill, backup } = await setup();
    state.storage.put('skills', { ...skill, id: 'skill-two' });
    const packageDirectory = join(root, 'presets', 'reader');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'preset.json'), '{"formatVersion":1}');
    state.storage.put('preset_installations', installation(packageDirectory));
    const created = await backup.create();
    const manifest = JSON.parse(await readFile(join(created.path, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(3);
    expect(manifest.resources).toHaveLength(2);
    await rm(directory, { recursive: true });
    await rm(packageDirectory, { recursive: true });
    await backup.restore(created.path);
    const restored = state.storage.get<Skill>('skills', skill.id)!;
    expect(restored.resourceRoot).not.toBe(directory);
    expect(restored.missing).toBe(false);
    expect(restored.digest).toBe(skill.digest);
    expect(state.storage.get<Skill>('skills', 'skill-two')?.resourceRoot).toBe(
      restored.resourceRoot,
    );
    expect(await readFile(join(restored.resourceRoot!, 'scripts', 'read.py'), 'utf8')).toContain(
      'restored script',
    );
    const preset = state.storage.get<PresetInstallation>('preset_installations', 'installed-one')!;
    expect(preset.status).toBe('installed');
    expect(await readFile(join(preset.directory!, 'preset.json'), 'utf8')).toContain(
      'formatVersion',
    );
    const second = await backup.create();
    await backup.restore(second.path);
    expect(await readFile(state.storage.get<Skill>('skills', skill.id)!.path, 'utf8')).toContain(
      'Read supplied material',
    );
  });

  it('兼容旧备份缺少新表，并将未备份的导入技能标记为缺失', async () => {
    const { state, skill, backup } = await setup(),
      created = await backup.create();
    const db = new Database(join(created.path, 'team.sqlite'));
    db.exec('DROP TABLE preset_installations');
    db.close();
    await writeFile(
      join(created.path, 'manifest.json'),
      JSON.stringify({ version: 1, artifacts: [] }),
    );
    await backup.restore(created.path);
    expect(state.storage.all('preset_installations')).toEqual([]);
    expect(state.storage.get<Skill>('skills', skill.id)).toMatchObject({
      id: skill.id,
      missing: true,
      path: '',
    });
  });

  it('校验技能脚本并拒绝被篡改的备份，保留当前数据库', async () => {
    const { state, skill, backup } = await setup(),
      created = await backup.create();
    await writeFile(join(created.path, 'resources', '0', 'scripts', 'read.py'), 'changed');
    state.storage.put('skills', { ...skill, name: '现有技能' });
    await expect(backup.restore(created.path)).rejects.toThrow('校验失败');
    expect(state.storage.get<Skill>('skills', skill.id)?.name).toBe('现有技能');
  });

  it('拒绝符号链接资源，恢复下载中预设时显示可重试状态', async () => {
    const { state, root, directory, backup } = await setup();
    await symlink(join(directory, 'SKILL.md'), join(directory, 'linked.md'));
    await expect(backup.create()).rejects.toThrow('符号链接');
    await rm(join(directory, 'linked.md'));
    state.storage.put('preset_installations', {
      ...installation(join(root, 'presets', 'pending')),
      status: 'downloading',
    });
    const created = await backup.create();
    await backup.restore(created.path);
    expect(
      state.storage.get<PresetInstallation>('preset_installations', 'installed-one'),
    ).toMatchObject({ status: 'failed', progress: 0 });
  });
});

it('备份恢复包含未合并的流式尾文且刷新配置快照', async () => {
  const { state, backup, skill } = await setup();
  const storage = state.storage;
  storage.setMetadata('history:binding', [{ message: { role: 'user', content: '旧工作投影' } }]);
  storage.setMetadata('history-validity:binding', { signature: 'old', sourceIds: ['source'] });
  storage.appendMessage({
    id: 'streamed',
    conversationId: 'room',
    authorType: 'bot',
    runId: 'run',
    content: '',
    artifactIds: [],
    status: 'draft',
    createdAt: new Date().toISOString(),
  });
  storage.messageStream.append(
    {
      id: 'first',
      runId: 'run',
      type: 'text',
      data: { delta: '首段' },
      createdAt: new Date().toISOString(),
    },
    'streamed',
  );
  storage.messageStream.flush('streamed');
  storage.messageStream.append(
    {
      id: 'tail',
      runId: 'run',
      type: 'text',
      data: { delta: '尾文' },
      createdAt: new Date().toISOString(),
    },
    'streamed',
  );
  const created = await backup.create();
  storage.put('skills', { ...skill, name: '备份后改名' });
  expect(state.snapshot().skills.find((item) => item.id === skill.id)?.name).toBe('备份后改名');
  await backup.restore(created.path);
  expect(storage.getMessage('streamed')).toMatchObject({
    content: '首段尾文',
    status: 'interrupted',
  });
  expect(storage.metadata('history:binding')).toBeUndefined();
  expect(storage.metadata('history-validity:binding')).toBeUndefined();
  expect(state.snapshot().skills.find((item) => item.id === skill.id)?.name).toBe(skill.name);
  storage.messageStream.recover();
  expect(storage.getMessage('streamed')?.content).toBe('首段尾文');
});
