import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareWorkspaceRuntime } from '../scripts/workspace-runtime/prepare.mjs';
import {
  assertRuntimeIntegrity,
  createRuntimeIntegrity,
} from '../scripts/workspace-runtime/integrity.mjs';

const downloads = vi.hoisted(() => ({ installations: 0 }));
vi.mock('../scripts/workspace-runtime/download.mjs', () => ({
  async downloadAsset(url: string, digest: string, cache: string) {
    const file = path.join(cache, digest);
    await mkdir(cache, { recursive: true });
    await writeFile(file, url);
    return file;
  },
  async unpack(archive: string, output: string) {
    const url = await readFile(archive, 'utf8');
    if (url.includes('nodejs.org')) {
      const directory = path.join(output, path.basename(url).replace(/\.(zip|tar\.gz)$/, ''));
      await put(directory, url.includes('win-x64') ? 'node.exe' : 'bin/node', 'node executable');
      await put(directory, 'LICENSE', 'license');
    } else if (url.includes('python-build-standalone')) {
      await put(
        output,
        url.includes('windows') ? 'python/python.exe' : 'python/bin/python3',
        'python executable',
      );
    } else await put(output, `${path.basename(url)}.fixture`, 'installed wheel');
  },
  async installNpm(name: string, record: { version: string }, output: string) {
    downloads.installations++;
    const directory = path.join(output, 'node_modules', name);
    await put(directory, 'package.json', JSON.stringify({ name, version: record.version }));
    if (name === '@deepseek-ai/libreoffice-kit') await put(directory, 'lib/cli.js', 'export {};');
    if (name === '@deepseek-ai/libreoffice-kit-darwin-arm64') {
      await put(directory, 'bin/libreoffice-kit', 'native executable');
      await put(directory, 'program/engine.dylib', 'native shared library');
    }
    if (name === '@deepseek-ai/libreoffice-kit-win32-x64')
      await put(directory, 'bin/libreoffice-kit.exe', 'native executable');
  },
}));

async function put(root: string, relative: string, content: string) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, 0o755);
}

describe('prepared workspace runtime integrity', () => {
  let directory: string;
  let options: { target: string; output: string; cache: string };
  beforeEach(async () => {
    downloads.installations = 0;
    directory = await mkdtemp(path.join(tmpdir(), 'maw-runtime-integrity-'));
    options = {
      target: 'mac-arm64',
      output: path.join(directory, 'runtime'),
      cache: path.join(directory, 'cache'),
    };
    await prepareWorkspaceRuntime(options);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reuses an intact runtime without reinstalling archives', async () => {
    const count = downloads.installations;
    await expect(prepareWorkspaceRuntime(options)).resolves.toBe(options.output);
    expect(downloads.installations).toBe(count);
  });

  it.each([
    'node/bin/node',
    'python/bin/python3',
    'office-skills/office-docx/SKILL.md',
    'node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/engine.dylib',
  ])('rebuilds after managed file removal: %s', async (relative) => {
    await rm(path.join(options.output, relative));
    const count = downloads.installations;
    await prepareWorkspaceRuntime(options);
    expect(downloads.installations).toBeGreaterThan(count);
    expect((await readFile(path.join(options.output, relative))).length).toBeGreaterThan(0);
  });

  it.each([
    'fonts/NotoSansCJKsc-Regular.otf',
    'node/bin/node',
    'node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/engine.dylib',
  ])('rebuilds after same-length critical file corruption: %s', async (relative) => {
    const file = path.join(options.output, relative);
    const original = await readFile(file);
    const bytes = Buffer.from(original);
    bytes[0] ^= 1;
    await writeFile(file, bytes);
    const count = downloads.installations;
    await prepareWorkspaceRuntime(options);
    expect(downloads.installations).toBeGreaterThan(count);
    expect(await readFile(file)).toEqual(original);
  });

  it('rebuilds a matching legacy manifest with no inventory', async () => {
    const file = path.join(options.output, 'runtime.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    delete manifest.integrity;
    await rm(options.output, { recursive: true });
    await mkdir(options.output);
    await writeFile(file, JSON.stringify(manifest));
    const count = downloads.installations;
    await prepareWorkspaceRuntime(options);
    expect(downloads.installations).toBeGreaterThan(count);
    const updated = JSON.parse(await readFile(file, 'utf8'));
    await expect(assertRuntimeIntegrity(options.output, updated)).resolves.toBeUndefined();
  });

  it('rebuilds when app-local Windows CRT files are lost', async () => {
    const crtDirectory = path.join(directory, 'crt');
    for (const file of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'])
      await put(crtDirectory, file, 'licensed CRT fixture');
    const windows = {
      ...options,
      target: 'win-x64',
      output: path.join(directory, 'windows'),
      crtDirectory,
    };
    await prepareWorkspaceRuntime(windows);
    const file = path.join(
      windows.output,
      'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/vcruntime140.dll',
    );
    await rm(file);
    const count = downloads.installations;
    await prepareWorkspaceRuntime(windows);
    expect(downloads.installations).toBeGreaterThan(count);
    expect(await readFile(file, 'utf8')).toBe('licensed CRT fixture');
  });

  it('allows signature changes only for recorded Mach-O binaries while keeping resource checks', async () => {
    const file = path.join(options.output, 'node/bin/node');
    const unsigned = Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from('unsigned executable'),
    ]);
    await writeFile(file, unsigned);
    const manifest = JSON.parse(await readFile(path.join(options.output, 'runtime.json'), 'utf8'));
    manifest.integrity = await createRuntimeIntegrity(options.output, manifest);
    await writeFile(file, Buffer.concat([unsigned, Buffer.from('new signature')]));
    await expect(assertRuntimeIntegrity(options.output, manifest)).rejects.toThrow('node/bin/node');
    await expect(
      assertRuntimeIntegrity(options.output, manifest, { allowCodeSigning: true }),
    ).resolves.toBeUndefined();
    const font = path.join(options.output, 'fonts/NotoSansCJKsc-Regular.otf');
    const original = await readFile(font);
    const modified = Buffer.from(original);
    modified[0] ^= 1;
    await writeFile(font, modified);
    await expect(
      assertRuntimeIntegrity(options.output, manifest, { allowCodeSigning: true }),
    ).rejects.toThrow('fonts/');
    await writeFile(font, original);
    await writeFile(file, Buffer.from('ordinary text'));
    await expect(
      assertRuntimeIntegrity(options.output, manifest, { allowCodeSigning: true }),
    ).rejects.toThrow('node/bin/node');
  });

  it('recognizes a native Mach-O helper outside the required entry paths', async () => {
    // NTFS does not preserve POSIX execute bits; the binary suffix identifies this fixture there.
    const helper = process.platform === 'win32' ? 'helper.bin' : 'helper';
    const relative = `node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/program/${helper}`;
    const file = path.join(options.output, relative);
    await put(options.output, relative, 'executable helper');
    const unsigned = Buffer.concat([
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from('native helper'),
    ]);
    await writeFile(file, unsigned);
    const manifest = JSON.parse(await readFile(path.join(options.output, 'runtime.json'), 'utf8'));
    manifest.integrity = await createRuntimeIntegrity(options.output, manifest);
    expect(manifest.integrity.files[relative]).toMatchObject({ machO: true });
    if (process.platform !== 'win32')
      expect(manifest.integrity.files[relative].executable).toBe(true);
    await writeFile(file, Buffer.concat([unsigned, Buffer.from('new signature')]));
    await expect(assertRuntimeIntegrity(options.output, manifest)).rejects.toThrow(relative);
    await expect(
      assertRuntimeIntegrity(options.output, manifest, { allowCodeSigning: true }),
    ).resolves.toBeUndefined();
  });
});
