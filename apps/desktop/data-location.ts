import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const fileName = 'data-location.json';

export async function readDataDirectory(defaultDirectory: string): Promise<string> {
  let contents: string;
  try { contents = await readFile(join(defaultDirectory, fileName), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultDirectory;
    throw new Error('无法读取数据目录设置，请检查应用目录的访问权限');
  }
  try {
    const config = JSON.parse(contents) as { version?: number; path?: unknown };
    if (config.version !== 1 || typeof config.path !== 'string' || !isAbsolute(config.path)) throw new Error();
    const path = resolve(config.path);
    if (!(await stat(path)).isDirectory() || !(await stat(join(path, 'team.sqlite'))).isFile()) throw new Error();
    return path;
  } catch {
    throw new Error('无法访问已设置的数据目录，请连接原磁盘并检查目录及 team.sqlite 文件');
  }
}

export async function saveDataDirectory(defaultDirectory: string, path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('请输入数据目录的完整路径');
  await mkdir(defaultDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(defaultDirectory, `${fileName}.${randomUUID()}.pending`);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, path: resolve(path) }), { mode: 0o600 });
    await rename(temporary, join(defaultDirectory, fileName));
  } finally { await rm(temporary, { force: true }); }
}
