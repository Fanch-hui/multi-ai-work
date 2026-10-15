import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertPackagedDependencies } from './package-dependencies.mjs';
import { assertRuntimeIntegrity } from './workspace-runtime/integrity.mjs';

const execute = promisify(execFile);
const source = path.resolve(process.argv[2]);
const directory = await mkdtemp(path.join(tmpdir(), 'maw-package-'));
try {
  // Ancestor dependencies must not hide omissions in the shipped ASAR.
  for (let ancestor = directory;; ancestor = path.dirname(ancestor)) {
    try { await access(path.join(ancestor, 'node_modules')); throw new Error('Package smoke directory has ancestor node_modules'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (ancestor === path.dirname(ancestor)) break;
  }
  const app = path.join(directory, path.basename(source));
  await cp(source, app, { recursive: true, verbatimSymlinks: true });
  const mac = process.platform === 'darwin';
  const resources = mac ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources');
  const executable = mac ? path.join(app, 'Contents', 'MacOS', 'multi-AI work') : path.join(app, 'multi-AI work.exe');
  const dependencies = assertPackagedDependencies(path.join(resources, 'app.asar'));
  if (mac) await execute('codesign', ['--verify', '--deep', '--strict', app]);
  const runtime = path.join(resources, 'workspace-runtime');
  const manifest = JSON.parse(await readFile(path.join(runtime, 'runtime.json'), 'utf8'));
  await assertRuntimeIntegrity(runtime, manifest, { allowCodeSigning: mac });
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
  const options = { cwd: directory, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, AI_TEAM_SMOKE_DATA_DIR: profile, HOME: profile, USERPROFILE: profile,
      APPDATA: profile, LOCALAPPDATA: profile, XDG_CACHE_HOME: profile, TMPDIR: directory, TEMP: directory, TMP: directory } };
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete options.env[name];
  const { stdout } = await execute(executable, ['--smoke-core'], options);
  const core = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .find(value => value?.coreReady && value?.mainBotReady);
  if (!core) throw new Error('Packaged Core did not report successful initialization');
  const { stdout: rendered } = await execute(process.execPath, [fileURLToPath(new URL('./workspace-runtime/smoke.mjs', import.meta.url)),
    runtime, path.join(directory, 'office')], options);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, dependencies, core,
    runtime: { payloadDigest: manifest.payloadDigest, ...JSON.parse(rendered) }, installed: false }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
