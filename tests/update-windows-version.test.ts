import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { windowsVersionCheck } from '../apps/desktop/update-helpers/windows-script.js';

it.skipIf(process.platform !== 'win32')('matches the Windows product version without accepting a different app version', async () => {
  const script = `$ErrorActionPreference = 'Stop'
${windowsVersionCheck}
@(
  (Test-AppVersion '0.6.16' '0.6.16'),
  (Test-AppVersion '0.6.16.0' '0.6.16'),
  (Test-AppVersion '0.6.15.0' '0.6.16'),
  (Test-AppVersion '0.6.16.1' '0.6.16')
) | ConvertTo-Json -Compress`;
  const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(executable,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  expect(JSON.parse(stdout)).toEqual([true, true, false, false]);
});
