import { open, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function packageFileDigest(filename) {
  const file = await open(filename, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || !before.size)
      throw new Error(`Desktop package is empty or not a file: ${filename}`);
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Desktop package changed while hashing: ${filename}`);
    }
    return { size: after.size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

export async function writePackageChecksums(directory) {
  const installers = (await readdir(directory))
    .filter((name) => /\.(exe|dmg|zip)$/.test(name))
    .sort();
  if (!installers.length) throw new Error('No desktop installers were generated');
  const lines = [];
  for (const name of installers) {
    const { sha256 } = await packageFileDigest(path.join(directory, name));
    lines.push(`${sha256}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  return lines;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log((await writePackageChecksums(path.resolve(process.argv[2] ?? 'release'))).join('\n'));
}
