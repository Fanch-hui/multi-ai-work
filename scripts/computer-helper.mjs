import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export async function buildComputerHelper(project) {
  if (process.platform !== 'darwin') return undefined;
  const directory = join(project, '.data', 'computer-build');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'computer-helper');
  await execute(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-module-cache-path',
      join(directory, 'module-cache'),
      '-parse-as-library',
      '-O',
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'ScreenCaptureKit',
      join(project, 'apps/desktop/computer-native.swift'),
      '-o',
      path,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return path;
}
