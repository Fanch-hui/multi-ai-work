import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const variants = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

export async function buildMacIcon(project) {
  const directory = await mkdtemp(join(tmpdir(), 'multi-ai-icon-'));
  const iconset = join(directory, 'App.iconset');
  const source = join(project, 'resources', 'icon-mac.png');
  try {
    await mkdir(iconset);
    for (const [name, size] of variants) {
      await execute('/usr/bin/sips', [
        '-z',
        String(size),
        String(size),
        source,
        '--out',
        join(iconset, name),
      ]);
    }
    await execute('/usr/bin/iconutil', [
      '-c',
      'icns',
      iconset,
      '-o',
      join(project, 'resources', 'icon-mac.icns'),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
