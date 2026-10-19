import { createHash } from 'node:crypto';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

export const skillByteLimit = 64 * 1024 * 1024;
export const skillFileLimit = 1000;
export const entryByteLimit = 128_000;
export const digestBytes = (content: Uint8Array | string) =>
  createHash('sha256').update(content).digest('hex');

export function parseSkillMetadata(content: string): {
  name?: string;
  description?: string;
  version?: string;
} {
  const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return {};
  const value = load(frontmatter, { schema: JSON_SCHEMA });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('技能 YAML 元数据必须为对象');
  const metadata = value as Record<string, unknown>;
  return Object.fromEntries(
    ['name', 'description', 'version'].flatMap((key) => {
      if (metadata[key] === undefined) return [];
      if (
        typeof metadata[key] !== 'string' &&
        !(key === 'version' && typeof metadata[key] === 'number')
      )
        throw new Error(`技能 ${key} 必须为文本`);
      return [[key, String(metadata[key]).trim()]];
    }),
  );
}

export async function digestSkillDirectory(root: string): Promise<string> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('技能资源根必须为普通目录');
  let bytes = 0,
    count = 0;
  const files: [string, string][] = [];
  async function visit(directory: string, prefix: string) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name),
        info = await lstat(path),
        relative = prefix + name;
      if (info.isSymbolicLink()) throw new Error('技能包不能包含符号链接');
      if (info.isDirectory()) await visit(path, `${relative}/`);
      else if (info.isFile()) {
        bytes += info.size;
        count++;
        if (bytes > skillByteLimit || count > skillFileLimit)
          throw new Error('技能包超过 64 MiB 或 1000 文件限制');
        files.push([relative, digestBytes(await readFile(path))]);
      } else throw new Error('技能包仅支持普通文件和目录');
    }
  }
  await visit(root, '');
  files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return digestBytes(files.map((item) => `${JSON.stringify(item)}\n`).join(''));
}
