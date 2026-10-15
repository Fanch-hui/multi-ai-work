import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, normalize, posix } from 'node:path';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = libraryRequire('@electron/asar');

export async function assertInstalledDependencies(project) {
  const [wanted, installed] = await Promise.all([
    join(project, 'pnpm-lock.yaml'), join(project, 'node_modules/.pnpm/lock.yaml'),
  ].map(async file => yaml.load(await readFile(file, 'utf8'))));
  const expected = wanted.importers['.'];
  const actual = installed.importers['.'];
  const stale = new Set();
  for (const group of ['dependencies', 'optionalDependencies']) {
    const names = new Set([...Object.keys(expected[group] ?? {}), ...Object.keys(actual[group] ?? {})]);
    for (const name of names) {
      const dependency = expected[group]?.[name];
      const current = actual[group]?.[name];
      if (current?.specifier !== dependency?.specifier || current?.version !== dependency?.version) stale.add(name);
    }
  }
  if (stale.size) throw new Error(`Installed production dependencies are stale: ${[...stale].join(', ')}. Run pnpm install --frozen-lockfile before packaging.`);
}

export function assertPackagedDependencies(archive) {
  const files = new Set(asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
  const visited = new Set();
  const missing = new Set();
  const pending = ['package.json'];
  while (pending.length) {
    const manifest = pending.pop();
    if (visited.has(manifest)) continue;
    visited.add(manifest);
    const metadata = JSON.parse(asar.extractFile(archive, normalize(manifest)).toString('utf8'));
    const optional = metadata.optionalDependencies ?? {};
    const dependencies = { ...metadata.dependencies, ...optional };
    for (const name of Object.keys(dependencies)) {
      const dependency = resolveManifest(files, manifest, name);
      if (dependency) pending.push(dependency);
      else if (!(name in optional)) missing.add(`${metadata.name ?? manifest} -> ${name}`);
    }
  }
  if (missing.size) throw new Error(`Packaged production dependencies are missing: ${[...missing].join(', ')}`);
  return visited.size - 1;
}

function resolveManifest(files, importer, name) {
  let directory = posix.dirname(importer);
  for (;;) {
    const candidate = posix.join(directory, 'node_modules', name, 'package.json');
    if (posix.basename(directory) !== 'node_modules' && files.has(candidate)) return candidate;
    if (directory === '.') return undefined;
    directory = posix.dirname(directory);
  }
}

export default function verifyPackagedDependencies(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : join(context.appOutDir, 'resources');
  const count = assertPackagedDependencies(join(resources, 'app.asar'));
  process.stdout.write(`Verified ${count} packaged production dependencies.\n`);
}
