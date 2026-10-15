import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectNativeSetup, type SetupOptions } from '../src/providers/native/setup.js';
import { commonBinDirectories } from '../src/providers/native/discovery.js';

let folder: string;
beforeEach(async () => { folder = await realpath(await mkdtemp(join(tmpdir(), 'multi-ai-native-setup-'))); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(folder, { recursive: true, force: true }); });

function options(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return { provider: 'antigravity', platform: 'darwin', profilePath: join(folder, 'profile'), appRuntimeDirectory: join(folder, 'runtimes'),
    path: '', homeDirectory: join(folder, 'home'), commonBinDirectories: [], ...overrides };
}
async function file(path: string, executable = true) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'fixture');
  if (executable) await chmod(path, 0o755);
  return path;
}

describe('native runtime discovery', () => {
  it('finds an existing installation despite Finder having only a simplified PATH', async () => {
    const home = join(folder, 'home');
    const entry = await file(join(home, '.local', 'bin', 'agy'));
    const bins = commonBinDirectories(home, 'darwin').filter(path => path.startsWith(home));
    const setup = await detectNativeSetup(options({ path: join(folder, 'system-bin'), commonBinDirectories: bins }));
    expect(setup).toMatchObject({ executable: entry, source: 'path', compatibility: 'unverified' });
    expect(setup.loginCommand).toBe(`'${entry}'`);
    expect(setup.loginCommand).not.toContain('HOME=');
  });

  it.each(['qoderclicn', 'qodercn'])('finds installed %s with Finder PATH and keeps the native login environment', async name => {
    const home = join(folder, 'home');
    const entry = await file(join(home, 'cli', `${name}.js`));
    const bin = join(home, '.local', 'bin');
    await mkdir(bin, { recursive: true }); await symlink(entry, join(bin, name));
    const bundled = await file(join(folder, 'bundled', 'qoderclicn'));
    const setup = await detectNativeSetup(options({ provider: 'qoder', path: join(folder, 'system-bin'),
      commonBinDirectories: [bin], bundledQoderPath: bundled }));
    expect(setup).toMatchObject({ executable: entry, source: 'path' });
    expect(setup.loginCommand).toContain(`'${entry}' login`);
    expect(setup.loginCommand).not.toContain('HOME=');
  });

  it('resolves an installed CLI symlink and prefers PATH over the app fallback', async () => {
    const entry = await file(join(folder, 'installed', 'agy'));
    const bin = join(folder, 'bin');
    await mkdir(bin); await symlink(entry, join(bin, 'agy'));
    await file(join(folder, 'runtimes', 'antigravity', 'bin', 'agy'));
    expect(await detectNativeSetup(options({ path: bin }))).toMatchObject({ executable: entry, source: 'path' });
  });

  it('falls back to an app-installed native executable', async () => {
    const entry = await file(join(folder, 'runtimes', 'antigravity', 'bin', 'agy'));
    expect(await detectNativeSetup(options())).toMatchObject({ executable: entry, source: 'app' });
  });

  it('finds the Windows native executable in the official local installation directory', async () => {
    const local = join(folder, 'AppData', 'Local'); vi.stubEnv('LOCALAPPDATA', local);
    const entry = await file(join(local, 'agy', 'bin', 'agy.exe'), false);
    const setup = await detectNativeSetup(options({ platform: 'win32', commonBinDirectories: commonBinDirectories(folder, 'win32') }));
    expect(setup).toMatchObject({ executable: entry, source: 'path' });
    expect(setup.loginCommand).toBe(`& '${entry}'`);
    expect(setup.installCommand).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
  });

  it('keeps an explicit executable ahead of every fallback and rejects an invalid explicit path', async () => {
    const explicit = await file(join(folder, 'chosen', 'agy'));
    await file(join(folder, 'runtimes', 'antigravity', 'bin', 'agy'));
    expect(await detectNativeSetup(options({ executable: explicit }))).toMatchObject({ executable: explicit, source: 'explicit' });
    await expect(detectNativeSetup(options({ executable: join(folder, 'missing') }))).rejects.toThrow('显式运行时路径不存在');
    const unusable = join(folder, 'not-executable');
    if (process.platform === 'win32') await mkdir(unusable);
    else await file(unusable, false);
    await expect(detectNativeSetup(options({ executable: unusable }))).rejects.toThrow('不可执行');
  });

  it('rejects an ACP server even when selected through an agy symlink', async () => {
    const server = await file(join(folder, 'agy_acp_server.par'));
    const link = join(folder, 'agy'); await symlink(server, link);
    await expect(detectNativeSetup(options({ executable: link }))).rejects.toThrow('请选择 agy CLI');
    const setup = await detectNativeSetup(options({ path: folder }));
    expect(setup.executable).toBeUndefined();
  });

  it('returns official installation guidance without claiming compatibility or authentication', async () => {
    const setup = await detectNativeSetup(options());
    expect(setup.executable).toBeUndefined(); expect(setup.loginCommand).toBeUndefined();
    expect(setup.compatibility).toBe('unverified');
    expect(setup.installCommand).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
  });

  it('quotes the selected CLI path without replacing the normal login environment', async () => {
    const entry = await file(join(folder, "user's bin", 'agy'));
    const setup = await detectNativeSetup(options({ executable: entry }));
    expect(setup.loginCommand).toContain("user'\\''s bin");
    expect(setup.loginCommand).not.toContain(options().profilePath);
  });
});
