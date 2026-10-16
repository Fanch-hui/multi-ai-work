import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageFileDigest, writePackageChecksums } from './package-checksums.mjs';

const repository = 'Fanch-hui/multi-ai-work';
const targets = [
  { platform: 'macos', architecture: 'arm64', kind: 'app-zip', extension: 'zip' },
  { platform: 'windows', architecture: 'x64', kind: 'nsis', extension: 'exe' },
];

export async function createReleaseManifest(directory, version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || !version.split('.').map(Number).every(Number.isSafeInteger)) throw new Error('Release version must be a stable semantic version');
  const assets = [];
  for (const { platform, architecture, kind, extension } of targets) {
    const name = `multi-AI-work-${version}-${architecture}.${extension}`;
    const digest = await packageFileDigest(path.join(directory, name));
    if (digest.size > 4 * 1024 ** 3) throw new Error(`Desktop package exceeds the update size limit: ${name}`);
    assets.push({ platform, architecture, kind,
      url: `https://github.com/${repository}/releases/download/v${version}/${name}`, ...digest });
  }
  return { version, assets };
}

export async function writeReleaseMetadata(directory, version) {
  const manifest = await createReleaseManifest(directory, version);
  await writePackageChecksums(directory);
  await writeFile(path.join(directory, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const manifest = await writeReleaseMetadata(path.resolve(process.argv[2] ?? 'release'), version);
  console.log(`Generated update metadata for ${manifest.version}: ${manifest.assets.length} platform packages`);
}
