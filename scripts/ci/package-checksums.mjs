import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'release');
const installers = (await readdir(directory)).filter(name => /\.(exe|dmg)$/.test(name)).sort();
if (!installers.length) throw new Error('No desktop installers were generated');

const lines = [];
for (const name of installers) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
