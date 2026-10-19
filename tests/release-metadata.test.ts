import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseManifest, writeReleaseMetadata } from '../scripts/ci/release-metadata.mjs';
import { selectUpdate } from '../src/updates/manifest.js';

const directories: string[] = [];
const version = '0.6.16';
const macName = `multi-AI-work-${version}-arm64.zip`;
const winName = `multi-AI-work-${version}-x64.exe`;
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'multi-ai-release-metadata-'));
  directories.push(directory);
  return directory;
}

describe('desktop update release metadata', () => {
  it('hashes the completed packages and generates a manifest accepted by both platforms', async () => {
    const directory = await fixture();
    const mac = Buffer.from('complete macOS application ZIP');
    const windows = Buffer.from('complete Windows NSIS installer');
    await writeFile(join(directory, macName), mac);
    await writeFile(join(directory, winName), windows);
    const manifest = await writeReleaseMetadata(directory, version);
    expect(Object.keys(manifest)).toEqual(['version', 'assets']);
    for (const [platform, architecture, body] of [
      ['macos', 'arm64', mac],
      ['windows', 'x64', windows],
    ] as const) {
      const update = selectUpdate(manifest, '0.6.15', platform, architecture);
      expect(update?.asset.size).toBe(body.length);
      expect(update?.asset.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    }
    expect(JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'))).toEqual(manifest);
    const sums = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8');
    expect(sums).toBe(
      manifest.assets
        .map((asset, index) => `${asset.sha256}  ${index === 0 ? macName : winName}\n`)
        .join(''),
    );
  });

  it('requires the matching final packages from both platforms', async () => {
    const directory = await fixture();
    await writeFile(join(directory, macName), 'macOS ZIP');
    await writeFile(join(directory, 'multi-AI-work-0.6.15-x64.exe'), 'old installer');
    await expect(writeReleaseMetadata(directory, version)).rejects.toThrow(winName);
    await expect(readFile(join(directory, 'latest.json'))).rejects.toThrow(/ENOENT/);
    await writeFile(join(directory, winName), '');
    await expect(createReleaseManifest(directory, version)).rejects.toThrow(/empty/);
  });

  it.each(['v0.6.16', '0.6.16-beta.1', '0.06.16', '0.6', '9007199254740992.0.0'])(
    'rejects unsupported release version %s',
    async (value) => {
      await expect(createReleaseManifest(await fixture(), value)).rejects.toThrow(
        /semantic version/,
      );
    },
  );
});
