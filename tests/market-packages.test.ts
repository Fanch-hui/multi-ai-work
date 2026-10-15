import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/core/state.js';
import type { Skill } from '../src/domain/types.js';
import { digestSkillDirectory, installPresetArchive, installationId, parseSkillMetadata } from '../src/core/market/package.js';
import { importSkillPackage } from '../src/core/skills.js';
import { fixtureEntries, fixturePreset, skillContent, zipFixture } from './preset-package-fixture.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('market preset packages', () => {
  let root: string, state: State;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'team-market-package-')); state = new State(join(root, 'app')); });
  afterEach(async () => { state.storage.close(); await rm(root, { recursive: true, force: true }); });
  async function archive(entries: Record<string, string> = fixtureEntries(), attributes?: Record<string, number>) {
    const path = join(root, 'preset.zip'); await writeFile(path, zipFixture(entries, attributes)); return path;
  }

  it('installs authorized immutable resources, shares skill versions and remains idempotent', async () => {
    const preset = fixturePreset(), path = await archive();
    const first = await installPresetArchive(state, path, 'official', preset);
    const duplicate = await installPresetArchive(state, path, 'official', preset);
    const local = await installPresetArchive(state, path, 'local');
    expect(duplicate).toEqual(first);
    expect(local.id).not.toBe(first.id);
    expect(first.id).toBe(installationId('official', preset.id, preset.version));
    expect(local.skillIds).toEqual(first.skillIds);
    expect(state.storage.all<Skill>('skills').filter(item => !item.bundled)).toHaveLength(1);
    const skill = state.storage.get<Skill>('skills', first.skillIds[0]!)!;
    expect(skill.bundled).toBeUndefined();
    expect(await readFile(join(skill.resourceRoot!, 'references/check.md'), 'utf8')).toContain('原文');
    expect(await digestSkillDirectory(skill.resourceRoot!)).toBe(preset.skills[0]!.digest);
  });

  it('rejects archive traversal and symlinks before registering resources', async () => {
    await expect(installPresetArchive(state, await archive({ ...fixtureEntries(), '../outside': 'escape' }), 'local')).rejects.toThrow();
    await expect(installPresetArchive(state, await archive(fixtureEntries(), { 'LICENSE': (0xa000 << 16) >>> 0 }), 'local'))
      .rejects.toThrow('符号链接');
    expect(state.storage.all('preset_installations')).toEqual([]);
  });

  it('preserves an existing version on replacement and repairs missing restored skill rows', async () => {
    const preset = fixturePreset(), installation = await installPresetArchive(state, await archive(), 'local');
    await expect(installPresetArchive(state, await archive(fixtureEntries(fixturePreset({ instructions: 'changed' }))), 'local'))
      .rejects.toThrow('不能替换');
    expect(state.storage.get('preset_installations', installation.id)).toEqual(installation);
    const skill = state.storage.get<Skill>('skills', installation.skillIds[0]!)!;
    state.storage.put('skills', { ...skill, missing: true });
    state.storage.put('preset_installations', { ...installation, status: 'missing' });
    const repaired = await installPresetArchive(state, await archive(fixtureEntries(preset)), 'local');
    expect(repaired.status).toBe('installed');
    expect(state.storage.get<Skill>('skills', skill.id)?.missing).toBeUndefined();
  });

  it('validates existing resources and package content when directory rename reports EPERM', async () => {
    const preset = fixturePreset(), path = await archive();
    const installation = await installPresetArchive(state, path, 'local');
    const skill = state.storage.get<Skill>('skills', installation.skillIds[0]!)!;
    state.storage.put('skills', { ...skill, missing: true });
    state.storage.put('preset_installations', { ...installation, status: 'missing' });
    const { rename } = await vi.importActual<typeof fs>('node:fs/promises');
    const error = Object.assign(new Error('directory exists'), { code: 'EPERM' });
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (existsSync(destination)) throw error;
      return rename(source, destination);
    });
    try {
      expect((await installPresetArchive(state, path, 'local')).status).toBe('installed');
      expect(state.storage.get<Skill>('skills', skill.id)?.missing).toBeUndefined();
      state.storage.put('preset_installations', { ...installation, status: 'missing' });
      const reference = join(skill.resourceRoot!, 'references/check.md');
      const original = await readFile(reference, 'utf8');
      await writeFile(reference, 'changed');
      await expect(installPresetArchive(state, path, 'local')).rejects.toThrow('本地技能资源已变化');
      expect(await readFile(reference, 'utf8')).toBe('changed');
      await writeFile(reference, original);
      await writeFile(join(installation.directory!, 'manifest.json'), JSON.stringify({
        formatVersion: 1, preset: { ...preset, instructions: 'changed' },
      }));
      await expect(installPresetArchive(state, path, 'local')).rejects.toThrow('同一预设版本不能替换内容');
      expect(state.storage.get('preset_installations', installation.id)).toMatchObject({ status: 'missing' });
    } finally { spy.mockRestore(); }
  });

  it('preserves a permission failure when the rename destination does not exist', async () => {
    const path = await archive();
    const error = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    const spy = vi.spyOn(fs, 'rename').mockRejectedValue(error);
    try { await expect(installPresetArchive(state, path, 'local')).rejects.toBe(error); }
    finally { spy.mockRestore(); }
    expect(state.storage.all('preset_installations')).toEqual([]);
    expect(existsSync(join(state.dataDirectory, 'skills', fixturePreset().skills[0]!.digest))).toBe(false);
  });

  it('rejects mismatched resources, catalogue metadata, missing license and cancelled installation', async () => {
    await expect(installPresetArchive(state, await archive({ ...fixtureEntries(), 'skills/evidence/references/check.md': 'changed' }), 'local'))
      .rejects.toThrow('资源校验');
    const path = await archive();
    await expect(installPresetArchive(state, path, 'official', fixturePreset({ instructions: 'other' }))).rejects.toThrow('官方目录');
    const files = fixtureEntries(); delete (files as Record<string, string>)['LICENSE'];
    await expect(installPresetArchive(state, await archive(files), 'local')).rejects.toThrow('许可文件');
    const controller = new AbortController(); controller.abort();
    await expect(installPresetArchive(state, await archive(), 'local', undefined, { signal: controller.signal })).rejects.toThrow();
    expect(state.storage.all('preset_installations')).toEqual([]);
  });

  it('parses folded YAML and hashes script-only changes on standalone imports', async () => {
    expect(parseSkillMetadata(skillContent)).toMatchObject({ name: 'evidence', description: '整理证据材料， 保留原文出处。' });
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'SKILL.md'), skillContent); await writeFile(join(source, 'check.py'), 'print(1)');
    const first = await importSkillPackage(state, join(source, 'SKILL.md'));
    await writeFile(join(source, 'check.py'), 'print(2)');
    const second = await importSkillPackage(state, join(source, 'SKILL.md'));
    expect(first.description).toBe('整理证据材料， 保留原文出处。');
    expect(first.content).toBe(second.content); expect(first.digest).not.toBe(second.digest);
  });

  it('cleans newly copied immutable resources when installation is cancelled before commit', async () => {
    const preset = fixturePreset(), path = await archive();
    const destination = join(state.dataDirectory, 'skills', preset.skills[0]!.digest);
    const controller = new AbortController(), check = controller.signal.throwIfAborted.bind(controller.signal);
    const spy = vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (existsSync(destination)) controller.abort();
      check();
    });
    try { await expect(installPresetArchive(state, path, 'local', undefined, { signal: controller.signal })).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(existsSync(destination)).toBe(false);
    expect(state.storage.all('preset_installations')).toEqual([]);
  });
});
