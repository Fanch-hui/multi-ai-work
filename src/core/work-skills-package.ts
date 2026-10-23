import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import type { Skill } from '../domain/types.js';
import type { PortableSkill } from '../domain/work-skills.js';
import { digestSkillDirectory, parseSkillMetadata } from './market/package-resources.js';
import { id } from './state.js';
import type { State } from './state.js';

export const portableSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    files: z
      .array(z.object({ path: z.string(), base64: z.string() }).strict())
      .min(1)
      .max(1000),
  })
  .strict();
const limit = 16 * 1024 * 1024;
const blocked = (name: string) =>
  ['.git', 'node_modules', '.aws', '.codex', '.ssh', '.npmrc', '.netrc', '.DS_Store'].includes(
    name,
  ) ||
  name.startsWith('.env') ||
  /\.(?:pem|key|p12|pfx)$/i.test(name) ||
  /^(?:credentials?|tokens?|cookies?)\.json$/i.test(name);

export function validatePortableSkill(input: unknown): PortableSkill {
  const skill = portableSkillSchema.parse(input);
  let total = 0;
  const seen = new Set<string>();
  for (const file of skill.files) {
    const parts = file.path.split('/');
    if (
      !file.path ||
      file.path.includes('\\') ||
      file.path.startsWith('/') ||
      parts.some(
        (part) => !part || part === '.' || part === '..' || part.includes(':') || blocked(part),
      )
    )
      throw new Error('技能资源路径无效');
    if (seen.has(file.path.toLowerCase())) throw new Error('技能资源路径重复');
    seen.add(file.path.toLowerCase());
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))
      throw new Error('技能资源编码无效');
    total += Buffer.byteLength(file.base64, 'base64');
    if (total > limit) throw new Error('分享技能资源上限为 16 MiB');
  }
  const entry = skill.files.find((file) => file.path === 'SKILL.md');
  if (!entry || Buffer.byteLength(entry.base64, 'base64') > 128000)
    throw new Error('技能须有不超过 128 KB 的 SKILL.md');
  parseSkillMetadata(Buffer.from(entry.base64, 'base64').toString('utf8'));
  return skill;
}

export async function exportPortableSkill(skill: Skill): Promise<PortableSkill> {
  if (skill.bundled || skill.presetOnly || skill.missing) throw new Error('请选择可分享的个人技能');
  const root = skill.resourceRoot ?? dirname(skill.path);
  const files: PortableSkill['files'] = [];
  let total = 0;
  async function visit(directory: string, prefix = '') {
    for (const name of await readdir(directory)) {
      if (blocked(name)) continue;
      const path = join(directory, name),
        info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('分享技能资源不能包含符号链接');
      const relative = posix.join(prefix, name);
      if (info.isDirectory()) await visit(path, relative);
      else if (info.isFile()) {
        total += info.size;
        if (total > limit || files.length >= 1000) throw new Error('分享技能资源超过限制');
        files.push({ path: relative, base64: (await readFile(path)).toString('base64') });
      }
    }
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('技能资源根无效');
  await visit(root);
  return validatePortableSkill({ name: skill.name, description: skill.description ?? '', files });
}

export async function installPortableSkill(state: State, input: unknown): Promise<Skill> {
  const portable = validatePortableSkill(input),
    skillId = id();
  const root = join(state.dataDirectory, 'skills', skillId);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const file of portable.files) {
      const path = join(root, ...file.path.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.base64, 'base64'), { mode: 0o600 });
    }
    const path = join(root, 'SKILL.md'),
      content = await readFile(path, 'utf8');
    const metadata = parseSkillMetadata(content);
    return {
      id: skillId,
      name: portable.name,
      description: portable.description,
      path,
      resourceRoot: root,
      content,
      version: metadata.version ?? '1',
      digest: await digestSkillDirectory(root),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
