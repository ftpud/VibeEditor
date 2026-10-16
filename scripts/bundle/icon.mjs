import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from './common.mjs';

// Finder and the Dock require an ICNS resource; Electron's window PNG alone
// leaves unpacked applications displaying the default Electron bundle icon.
export async function macApplicationIcon(png, directory) {
  const iconset = path.join(directory, 'app.iconset');
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      await run('/usr/bin/sips', ['-z', String(pixels), String(pixels), png, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
  }
  const icon = path.join(directory, 'app.icns');
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon]);
  return icon;
}
