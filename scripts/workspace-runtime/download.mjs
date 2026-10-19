import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function downloadAsset(url, digest, cache, algorithm = 'sha256') {
  await mkdir(cache, { recursive: true });
  const destination = path.join(cache, digest);
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Runtime download HTTP ${response.status}: ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash(algorithm).update(bytes).digest('hex') !== digest) {
    await rm(destination, { force: true });
    throw new Error(`Runtime checksum mismatch: ${url}`);
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return destination;
}

export async function unpack(archive, destination, strip = 0) {
  await mkdir(destination, { recursive: true });
  const args = ['-xf', archive, '-C', destination];
  if (strip) args.push(`--strip-components=${strip}`);
  execFileSync('tar', args, { stdio: 'inherit', timeout: 120_000 });
}

export async function installNpm(name, record, root, cache) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity))
    throw new Error(`Invalid npm integrity: ${name}`);
  const digest = Buffer.from(record.integrity.slice(7), 'base64').toString('hex');
  const archive = await downloadAsset(record.url, digest, cache, 'sha512');
  const destination = path.join(root, 'node_modules', name);
  await unpack(archive, destination, 1);
  const actual = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'));
  if (actual.name !== name || actual.version !== record.version)
    throw new Error(`Unexpected npm package: ${name}`);
}
