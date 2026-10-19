import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentPreset, PresetInstallation } from '../../domain/market.js';
import type { Skill } from '../../domain/types.js';
import type { State } from '../state.js';
import { extractPresetArchive } from './package-archive.js';
import {
  digestBytes,
  digestSkillDirectory,
  entryByteLimit,
  parseSkillMetadata,
} from './package-resources.js';
import { manifestSchema, presetSchema } from './schema.js';

export { digestSkillDirectory, parseSkillMetadata } from './package-resources.js';
export const installationId = (source: 'official' | 'local', presetId: string, version: string) =>
  `${source}-${digestBytes(JSON.stringify([presetId, version])).slice(0, 40)}`;
const installs = new Map<string, Promise<unknown>>();

export async function installPresetArchive(
  state: State,
  archivePath: string,
  source: 'official' | 'local',
  expected?: AgentPreset,
  options: { signal?: AbortSignal } = {},
): Promise<PresetInstallation> {
  const previous = installs.get(state.dataDirectory) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => install(state, archivePath, source, expected, options.signal));
  installs.set(state.dataDirectory, operation);
  try {
    return await operation;
  } finally {
    if (installs.get(state.dataDirectory) === operation) installs.delete(state.dataDirectory);
  }
}

function metadata(preset: AgentPreset) {
  const { download: _download, ...value } = preset;
  return value;
}

async function validatePreset(
  directory: string,
  source: 'official' | 'local',
  expected?: AgentPreset,
) {
  const path = join(directory, 'manifest.json');
  if ((await stat(path)).size > 512 * 1024) throw new Error('预设清单过大');
  const { preset } = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (
    source === 'official' &&
    (!expected || !isDeepStrictEqual(metadata(preset), metadata(presetSchema.parse(expected))))
  )
    throw new Error('预设内容与官方目录不一致');
  for (const skill of preset.skills) {
    if (
      source === 'official' &&
      (!skill.source || (skill.source.stars ?? 0) < 200 || !skill.source.verifiedAt)
    )
      throw new Error('官方技能缺少符合要求的来源核验记录');
    const root = join(directory, skill.directory);
    if ((await digestSkillDirectory(root)) !== skill.digest)
      throw new Error(`技能资源校验失败：${skill.name}`);
    const content = await readFile(join(root, 'SKILL.md'), 'utf8');
    if (Buffer.byteLength(content) > entryByteLimit) throw new Error('技能入口超过 128 KiB 限制');
    parseSkillMetadata(content);
  }
  const licenses = await licenseFiles(directory);
  if (!licenses.length) throw new Error('预设包缺少 LICENSE 或 NOTICE 许可文件');
  return preset;
}

async function licenseFiles(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const files: string[] = [];
  async function visit(root: string) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(root, entry.name));
      else if (
        /^(LICENSE|NOTICE)([.-].*)?$/i.test(entry.name) &&
        (await stat(join(root, entry.name))).size > 0
      )
        files.push(join(root, entry.name));
    }
  }
  await visit(directory);
  return files;
}

async function directoryCollision(error: unknown, destination: string) {
  if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
    return false;
  // Windows reports EPERM when rename targets an existing nonempty directory.
  const info = await lstat(destination).catch(() => undefined);
  return !!info?.isDirectory() && !info.isSymbolicLink();
}

async function immutableDirectory(source: string, destination: string, expectedDigest: string) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.skill-'));
  let created = false;
  try {
    const content = join(staging, 'content');
    await cp(source, content, { recursive: true });
    try {
      await rename(content, destination);
      created = true;
    } catch (error) {
      if (!(await directoryCollision(error, destination))) throw error;
    }
    if ((await digestSkillDirectory(destination)) !== expectedDigest)
      throw new Error('本地技能资源已变化，请修复后重新安装');
    return created;
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function install(
  state: State,
  archivePath: string,
  source: 'official' | 'local',
  expected?: AgentPreset,
  signal?: AbortSignal,
) {
  const parent = join(state.dataDirectory, 'presets');
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.install-'));
  const newSkills: string[] = [];
  let packageDirectory: string | undefined,
    committed = false;
  try {
    signal?.throwIfAborted();
    await extractPresetArchive(archivePath, staging, signal);
    const preset = await validatePreset(staging, source, expected);
    const digest = digestBytes(await readFile(archivePath));
    if (source === 'official' && expected?.download && digest !== expected.download.sha256)
      throw new Error('预设包摘要校验失败');
    const id = installationId(source, preset.id, preset.version);
    const old = state.storage.get<PresetInstallation>('preset_installations', id);
    if (old?.status === 'installed') {
      if (!isDeepStrictEqual(metadata(old.preset), metadata(preset)))
        throw new Error('同一预设版本不能替换内容');
      if (old.directory) {
        await validatePreset(old.directory, source, expected);
        for (const item of preset.skills) {
          const skill = state.storage.get<Skill>('skills', `skill-${item.digest}`);
          if (
            !skill?.resourceRoot ||
            (await digestSkillDirectory(skill.resourceRoot)) !== item.digest
          )
            throw new Error('已安装技能资源缺失或已变化');
        }
        return old;
      }
    }
    const destination = join(parent, id);
    const skills: Skill[] = [];
    for (const item of preset.skills) {
      signal?.throwIfAborted();
      const resourceRoot = join(state.dataDirectory, 'skills', item.digest);
      if (await immutableDirectory(join(staging, item.directory), resourceRoot, item.digest))
        newSkills.push(resourceRoot);
      const content = await readFile(join(resourceRoot, 'SKILL.md'), 'utf8');
      skills.push({
        id: `skill-${item.digest}`,
        name: item.name,
        description: item.description,
        path: join(resourceRoot, 'SKILL.md'),
        resourceRoot,
        content,
        digest: item.digest,
        source: item.source,
        version: parseSkillMetadata(content).version ?? '1',
      });
    }
    signal?.throwIfAborted();
    try {
      await rename(staging, destination);
      packageDirectory = destination;
    } catch (error) {
      if (!(await directoryCollision(error, destination))) throw error;
      const storedPreset = await validatePreset(destination, source, expected);
      if (!isDeepStrictEqual(metadata(storedPreset), metadata(preset)))
        throw new Error('同一预设版本不能替换内容');
    }
    const result: PresetInstallation = {
      id,
      preset: expected ?? preset,
      source,
      status: 'installed',
      progress: 100,
      directory: destination,
      skillIds: skills.map((skill) => skill.id),
      digest,
      createdAt: old?.createdAt ?? new Date().toISOString(),
    };
    state.storage.transaction(() => {
      for (const skill of skills) {
        const existing = state.storage.get<Skill>('skills', skill.id);
        if (!existing || existing.missing) state.storage.put('skills', skill);
      }
      state.storage.put('preset_installations', result);
    });
    committed = true;
    state.changed();
    return result;
  } finally {
    if (!committed) {
      const referenced = new Set(
        state.storage.all<Skill>('skills').map((skill) => skill.resourceRoot),
      );
      for (const path of newSkills)
        if (!referenced.has(path)) await rm(path, { recursive: true, force: true });
      if (packageDirectory) await rm(packageDirectory, { recursive: true, force: true });
    }
    await rm(staging, { recursive: true, force: true });
  }
}
