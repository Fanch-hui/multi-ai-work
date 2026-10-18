import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const resources = join(dirname(fileURLToPath(import.meta.url)), '../resources');
for (const scale of [1, 2]) {
  const suffix = scale === 1 ? '' : '@2x';
  await sharp(join(resources, 'trayTemplate.svg'), { density: 72 * scale })
    .png().toFile(join(resources, `trayTemplate${suffix}.png`));
}
await sharp(join(resources, 'icon.png')).resize(64, 64).png().toFile(join(resources, 'tray.png'));
