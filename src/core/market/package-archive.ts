import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Open } from 'unzipper';
import { resourcePathSchema } from './schema.js';

export const archiveByteLimit = 256 * 1024 * 1024;
const packageFileLimit = 5000;

export async function extractPresetArchive(
  archive: string,
  destination: string,
  signal?: AbortSignal,
) {
  if ((await stat(archive)).size > archiveByteLimit) throw new Error('预设包超过 256 MiB 限制');
  const directory = await Open.file(archive);
  if (directory.files.length > packageFileLimit) throw new Error('预设包超过 5000 文件限制');
  let total = 0;
  const paths = new Set<string>();
  for (const entry of directory.files) {
    const path = entry.type === 'Directory' ? entry.path.replace(/\/$/, '') : entry.path;
    resourcePathSchema.parse(path);
    const folded = path.toLowerCase();
    if (paths.has(folded)) throw new Error('预设包存在重复资源路径');
    paths.add(folded);
    const type = (entry.externalFileAttributes >>> 16) & 0xf000;
    if (type !== 0 && type !== 0x8000 && type !== 0x4000)
      throw new Error('预设包不能包含符号链接或特殊文件');
    if (entry.flags & 1) throw new Error('预设包不能加密');
    if (
      path
        .split('/')
        .some(
          (part) =>
            ['.git', '.aws', '.codex', 'node_modules'].includes(part) || part.startsWith('.env'),
        )
    )
      throw new Error('预设包包含不支持的资源目录');
    total += entry.uncompressedSize;
    if (!Number.isSafeInteger(total) || total > archiveByteLimit)
      throw new Error('预设包解压后超过 256 MiB 限制');
  }
  let extracted = 0;
  for (const entry of directory.files) {
    signal?.throwIfAborted();
    const output = join(destination, entry.path);
    if (entry.type === 'Directory') {
      await mkdir(output, { recursive: true });
      continue;
    }
    await mkdir(dirname(output), { recursive: true });
    let entryBytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        entryBytes += chunk.length;
        extracted += chunk.length;
        callback(
          entryBytes > entry.uncompressedSize || extracted > archiveByteLimit
            ? new Error('预设包资源长度超出声明')
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      entry.stream(),
      limiter,
      createWriteStream(output, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (entryBytes !== entry.uncompressedSize) throw new Error('预设包资源不完整');
  }
}
