import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
if (metadata.packageManager !== `pnpm@${process.env.CI_PNPM_VERSION}`) {
  throw new Error('CI_PNPM_VERSION must match package.json packageManager');
}
const windows = process.platform === 'win32';
const root = windows ? 'D:\\maw-ci' : path.join(process.env.RUNNER_TEMP, 'maw-ci');
const localAppData = path.join(root, 'profile', 'AppData', 'Local');
const values = {
  CI_PNPM_STORE: path.join(root, 'pnpm-store'),
  ELECTRON_CACHE: windows
    ? path.join(localAppData, 'electron', 'Cache')
    : path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  ELECTRON_BUILDER_CACHE: path.join(root, 'electron-builder'),
  ...(windows
    ? {
        USERPROFILE: path.join(root, 'profile'),
        HOME: path.join(root, 'profile'),
        APPDATA: path.join(root, 'profile', 'AppData', 'Roaming'),
        LOCALAPPDATA: localAppData,
        TEMP: path.join(root, 'tmp'),
        TMP: path.join(root, 'tmp'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        npm_config_cache: path.join(root, 'npm'),
        PNPM_HOME: path.join(root, 'pnpm'),
      }
    : {}),
};
for (const [name, directory] of Object.entries(values)) {
  await mkdir(directory, { recursive: true });
  await appendFile(process.env.GITHUB_ENV, `${name}=${directory}\n`);
}
if (windows) await appendFile(process.env.GITHUB_PATH, `${values.PNPM_HOME}\n`);
