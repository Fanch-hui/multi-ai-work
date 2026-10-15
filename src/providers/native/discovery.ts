import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export async function executableFile(candidate: string, windows: boolean): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidate.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'));
    if (!(await stat(resolved)).isFile() || /\.(cmd|bat)$/i.test(resolved)) return;
    await access(resolved, windows || /\.(js|mjs|cjs)$/i.test(resolved) ? constants.R_OK : constants.X_OK);
    return resolved;
  } catch { return undefined; }
}

/** Checks fixed executable locations without reading shell configuration or authentication. */
export function commonBinDirectories(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [join(local, 'agy', 'bin'), join(home, '.local', 'bin')];
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
}
