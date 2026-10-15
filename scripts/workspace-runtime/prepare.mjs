import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { downloadAsset, installNpm, unpack } from './download.mjs';
import { assertRuntimeIntegrity, createRuntimeIntegrity, RuntimeIntegrityError } from './integrity.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const lock = JSON.parse(await readFile(new URL('./lock.json', import.meta.url), 'utf8'));
export const runtimeTargets = Object.keys(lock.targets);

async function sourceDigest(directory) {
  const hash = createHash('sha256');
  async function visit(root) {
    for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(root, item.name);
      if (item.isDirectory()) await visit(target);
      else { hash.update(path.relative(directory, target)); hash.update(await readFile(target)); }
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function installInterpreters(target, output, cache, staging) {
  const record = lock.targets[target];
  const nodeFile = `node-v${lock.nodeVersion}-${record.nodeArchive}`;
  const nodeArchive = await downloadAsset(`https://nodejs.org/dist/v${lock.nodeVersion}/${nodeFile}`, record.nodeSha256, cache);
  await unpack(nodeArchive, path.join(staging, 'node'));
  const nodeSource = path.join(staging, 'node', nodeFile.replace(/\.(zip|tar\.gz)$/, ''));
  const nodeDirectory = path.join(output, 'node', 'bin');
  await mkdir(nodeDirectory, { recursive: true });
  const executable = target === 'win-x64' ? 'node.exe' : 'node';
  await cp(path.join(nodeSource, ...(target === 'win-x64' ? [executable] : ['bin', executable])), path.join(nodeDirectory, executable));
  await cp(path.join(nodeSource, 'LICENSE'), path.join(output, 'node', 'LICENSE'));
  const pythonFile = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${record.pythonTarget}-install_only_stripped.tar.gz`;
  const pythonArchive = await downloadAsset(`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(pythonFile)}`, record.pythonSha256, cache);
  await unpack(pythonArchive, output);
  const packages = path.join(output, 'python', ...(target === 'win-x64' ? ['Lib', 'site-packages'] : ['lib', 'python3.12', 'site-packages']));
  for (const wheel of [...record.wheels, ...lock.wheels]) {
    await unpack(await downloadAsset(wheel.url, wheel.sha256, cache), packages);
  }
}

async function windowsCrtDigests(source) {
  if (!source) throw new Error('Windows preparation requires --crt-dir pointing to the licensed Microsoft x64 VC Redist directory');
  const files = (await readdir(source)).filter(name => name.toLowerCase().endsWith('.dll'));
  for (const required of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
    if (!files.some(name => name.toLowerCase() === required)) throw new Error(`Missing app-local CRT: ${required}`);
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file,
    createHash('sha256').update(await readFile(path.join(source, file))).digest('hex')])));
}

async function copyWindowsCrt(source, engine, digests) {
  const directories = [];
  async function visit(root) {
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.some(item => item.isFile() && item.name.toLowerCase().endsWith('.exe'))) directories.push(root);
    for (const item of entries) if (item.isDirectory()) await visit(path.join(root, item.name));
  }
  await visit(engine);
  if (!directories.length) throw new Error('The Windows Office engine is missing its native executable');
  for (const file of Object.keys(digests)) {
    for (const directory of directories) await cp(path.join(source, file), path.join(directory, file));
  }
  return digests;
}

export async function prepareWorkspaceRuntime({ target, output, cache, crtDirectory }) {
  if (!runtimeTargets.includes(target)) throw new Error(`Unsupported runtime target: ${target}`);
  output = path.resolve(output); cache = path.resolve(cache);
  if (output === projectRoot || output === path.parse(output).root) throw new Error('Runtime output must be a dedicated directory');
  if (target === 'win-x64' && !crtDirectory) throw new Error('Specify --crt-dir for app-local Microsoft VC Redist files');
  const officeSource = path.join(projectRoot, 'resources', 'office');
  const crt = target === 'win-x64' ? await windowsCrtDigests(crtDirectory) : undefined;
  const payloadDigest = createHash('sha256').update(JSON.stringify({ format: 3, target, lock, crt, skills: await sourceDigest(officeSource) })).digest('hex');
  try {
    const current = JSON.parse(await readFile(path.join(output, 'runtime.json'), 'utf8'));
    if (current.payloadDigest === payloadDigest && (!crtDirectory || current.crt)) {
      try { await assertRuntimeIntegrity(output, current); return output; }
      catch (error) {
        if (!(error instanceof RuntimeIntegrityError) && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      if ((await lstat(output)).isDirectory() && (await readdir(output)).length) throw new Error('Runtime output contains unrelated files');
    } catch (inspection) { if (inspection.code !== 'ENOENT') throw inspection; }
  }
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), '.office-runtime-'));
  try {
    const payload = path.join(staging, 'payload');
    await mkdir(payload);
    await installInterpreters(target, payload, cache, staging);
    const platform = target === 'win-x64' ? 'win32' : 'darwin';
    const arch = target === 'win-x64' ? 'x64' : 'arm64';
    for (const [name, record] of Object.entries(lock.npm)) {
      if (record.os && !record.os.includes(platform) || record.cpu && !record.cpu.includes(arch)) continue;
      await installNpm(name, record, payload, cache);
    }
    await mkdir(path.join(payload, 'fonts'));
    await cp(await downloadAsset(lock.font.url, lock.font.sha256, cache), path.join(payload, 'fonts', lock.font.name));
    await cp(officeSource, path.join(payload, 'office-skills'), { recursive: true });
    await cp(path.join(projectRoot, 'licenses', 'office'), path.join(payload, 'licenses'), { recursive: true });
    if (crt) await copyWindowsCrt(crtDirectory, path.join(payload, 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64'), crt);
    const manifest = { schemaVersion: 1, platform, arch, payloadDigest,
      node: lock.nodeVersion, python: lock.pythonVersion, kit: lock.kitVersion, pythonPackages: lock.pythonPackages,
      font: { name: lock.font.name, sha256: lock.font.sha256 }, crt };
    manifest.integrity = await createRuntimeIntegrity(payload, manifest);
    await writeFile(path.join(payload, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
    await rm(output, { recursive: true, force: true });
    await cp(payload, output, { recursive: true, verbatimSymlinks: true });
    return output;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { target: { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' }, 'crt-dir': { type: 'string' } } });
  const target = values.target ?? (process.platform === 'darwin' ? 'mac-arm64' : 'win-x64');
  const output = values.output ?? path.join(projectRoot, 'workspace-runtime', target);
  const cache = values.cache ?? path.join(projectRoot, 'workspace-runtime', 'downloads');
  console.log(await prepareWorkspaceRuntime({ target, output, cache, crtDirectory: values['crt-dir'] }));
}
