import { cp, mkdir, rm, symlink, mkdtemp, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { root, output, run } from './common.mjs';

export async function packageGatewayInstaller(built, destination, version, smokeApplication) {
  const basename = `vibe-gateway-${version}-${process.platform}-${process.arch}`;
  if (process.platform === 'darwin') {
    const staging = path.join(output, 'staging', 'gateway-dmg');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await cp(path.join(built, 'Vibe Gateway.app'), path.join(staging, 'Vibe Gateway.app'), { recursive: true, verbatimSymlinks: true });
      await symlink('/Applications', path.join(staging, 'Applications'));
      const installer = path.join(destination, `${basename}.dmg`);
      await run('hdiutil', ['create', '-ov', '-volname', 'Vibe Gateway', '-srcfolder', staging, '-format', 'UDZO', installer]);
      await run('hdiutil', ['verify', installer]);
      return installer;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const installer = path.join(destination, `${basename}-setup.exe`);
  const compiler = process.env.VIBE_MAKENSIS ?? path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe');
  await run(compiler, ['/V3', `/DSOURCE=${built}`, `/DOUTPUT=${installer}`, `/DVERSION=${version}`, path.join(root, 'scripts/bundle/gateway-installer.nsi')]);
  // Exercise the actual installer and installed embedded Editor on the Windows runner.
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vibe-installer-'));
  const installed = path.join(temporary, 'Gateway');
  try {
    // NSIS requires /D to be the final argument, without embedded quotes.
    await run(installer, ['/S', `/D=${installed}`]);
    const executable = path.join(installed, 'Vibe Gateway.exe');
    await access(executable);
    await smokeApplication(executable, []);
    await smokeApplication(executable, ['--vibe-editor']);
  } finally {
    try {
      // _?= keeps the uninstaller in place so the process waits for completion.
      await run(path.join(installed, 'Uninstall.exe'), ['/S', `_?=${installed}`]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return installer;
}
