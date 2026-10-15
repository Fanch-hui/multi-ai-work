import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { assertInstalledDependencies, assertPackagedDependencies } from '../scripts/package-dependencies.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = libraryRequire('@electron/asar') as { createPackage(source: string, target: string): Promise<void> };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'multi-ai-package-dependencies-'));
  directories.push(path);
  return path;
}

async function writeManifest(root: string, path: string, metadata: Record<string, unknown>) {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, 'package.json'), JSON.stringify(metadata));
}

async function archive(root: string, filename = 'app.asar') {
  const path = join(root, filename);
  await asar.createPackage(join(root, 'app'), path);
  return path;
}

describe('packaging dependency validation', () => {
  it('rejects a stale installed production importer despite an up-to-date source lock', async () => {
    const root = await fixture();
    const dependency = { specifier: '4.3.2', version: '4.3.2' };
    await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true });
    await writeFile(join(root, 'pnpm-lock.yaml'), JSON.stringify({ importers: { '.': { dependencies: { 'js-yaml': dependency } } } }));
    await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), JSON.stringify({ importers: { '.': { dependencies: {} } } }));
    await expect(assertInstalledDependencies(root)).rejects.toThrow(/js-yaml.*pnpm install --frozen-lockfile/);
    await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), JSON.stringify({ importers: { '.': { dependencies: { 'js-yaml': dependency }, devDependencies: { unrelated: '1' } } } }));
    await expect(assertInstalledDependencies(root)).resolves.toBeUndefined();
  });

  it('rejects a missing root dependency even when the source ancestor provides it', async () => {
    const root = await fixture();
    await writeManifest(root, 'app', { name: 'app', dependencies: { 'js-yaml': '4.3.2' } });
    await writeManifest(root, 'node_modules/js-yaml', { name: 'js-yaml' });
    const path = await archive(root);
    expect(() => assertPackagedDependencies(path)).toThrow('app -> js-yaml');
  });

  it('rejects a missing transitive production dependency', async () => {
    const root = await fixture();
    await writeManifest(root, 'app', { name: 'app', dependencies: { parser: '1' } });
    await writeManifest(root, 'app/node_modules/parser', { name: 'parser', dependencies: { helper: '1' } });
    const path = await archive(root);
    expect(() => assertPackagedDependencies(path)).toThrow('parser -> helper');
  });

  it('accepts hoisted and nested dependencies with platform optional packages absent', async () => {
    const root = await fixture();
    await writeManifest(root, 'app', { name: 'app', dependencies: { parser: '1', helper: '1' }, devDependencies: { test: '1' } });
    await writeManifest(root, 'app/node_modules/parser', { name: 'parser', dependencies: { helper: '1', nested: '1' }, optionalDependencies: { platform: '1' } });
    await writeManifest(root, 'app/node_modules/helper', { name: 'helper' });
    await writeManifest(root, 'app/node_modules/parser/node_modules/nested', { name: 'nested', dependencies: { helper: '1' } });
    expect(assertPackagedDependencies(await archive(root))).toBe(3);
  });

  it('requires the target sharp native package while allowing other platform packages to be absent', async () => {
    const root = await fixture();
    await writeManifest(root, 'app', { name: 'app', dependencies: { sharp: '0.35.5' } });
    await writeManifest(root, 'app/node_modules/sharp', { name: 'sharp', optionalDependencies: {
      '@img/sharp-win32-x64': '0.35.5', '@img/sharp-darwin-arm64': '0.35.5',
    } });
    const incomplete = await archive(root);
    expect(() => assertPackagedDependencies(incomplete, { platform: 'win32', arch: 'x64' }))
      .toThrow('sharp -> @img/sharp-win32-x64');
    await writeManifest(root, 'app/node_modules/@img/sharp-win32-x64', { name: '@img/sharp-win32-x64' });
    expect(assertPackagedDependencies(await archive(root, 'complete.asar'), { platform: 'win32', arch: 'x64' })).toBe(2);
  });

  it('requires the ripgrep platform package used by file search', async () => {
    const root = await fixture();
    await writeManifest(root, 'app', { name: 'app', dependencies: { '@vscode/ripgrep': '1.18.0' } });
    await writeManifest(root, 'app/node_modules/@vscode/ripgrep', { name: '@vscode/ripgrep', optionalDependencies: {
      '@vscode/ripgrep-win32-x64': '1.18.0', '@vscode/ripgrep-darwin-arm64': '1.18.0',
    } });
    const incomplete = await archive(root);
    expect(() => assertPackagedDependencies(incomplete, { platform: 'win32', arch: 'x64' }))
      .toThrow('@vscode/ripgrep -> @vscode/ripgrep-win32-x64');
    await writeManifest(root, 'app/node_modules/@vscode/ripgrep-win32-x64', { name: '@vscode/ripgrep-win32-x64' });
    expect(assertPackagedDependencies(await archive(root, 'complete.asar'), { platform: 'win32', arch: 'x64' })).toBe(2);
  });
});
