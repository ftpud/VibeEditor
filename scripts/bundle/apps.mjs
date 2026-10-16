import { packager } from '@electron/packager';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, output, json, writeJson, run, stageWorkspace, sha256 } from './common.mjs';

if (!(process.platform === 'darwin' && process.arch === 'arm64') && !(process.platform === 'win32' && process.arch === 'x64')) throw new Error('Build apps on macOS ARM64 or Windows x64');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const coresDirectory = path.join(output, 'cores');
const cores = {};
for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
  const metadata = await json(path.join(coresDirectory, `core-${target}.tar.gz.json`));
  const digest = await sha256(path.join(coresDirectory, metadata.archive));
  if (!new RegExp(`^${commit}-node[0-9]+-bundle-[a-zA-Z0-9-]+$`).test(metadata.release) || metadata.archive !== `core-${target}.tar.gz` || metadata.schema !== 1 || metadata.commit !== commit || metadata.target !== target || metadata.sha256 !== digest) throw new Error(`Invalid or mismatched Core artifact: ${target}`);
  cores[target] = metadata;
}
const version = (await json(path.join(root, 'package.json'))).version;
const electronVersion = (await json(path.join(root, 'node_modules/electron/package.json'))).version;
let desktopBundle;
for (const kind of ['desktop', 'gateway']) {
  const staging = path.join(output, 'staging', kind);
  await rm(staging, { recursive: true, force: true });
  await stageWorkspace(staging, kind);
  const appDirectory = path.join(staging, 'packages', kind);
  for (const name of ['dist-electron', 'dist-renderer', 'assets']) await cp(path.join(root, 'packages', kind, name), path.join(appDirectory, name), { recursive: true, filter: source => !source.endsWith('.test.js') });
  // Remove the workspace's self-link before dereferencing the dependency tree.
  // Otherwise copying it into the app recurses through its own node_modules.
  await rm(path.join(staging, 'node_modules/@remote-ide', kind), { force: true });
  for (const dependency of ['acp', 'protocol']) await cp(path.join(root, 'packages', dependency, 'dist'), path.join(staging, 'packages', dependency, 'dist'), { recursive: true });
  // Electron's application root is the package, with its installed runtime closure.
  await cp(path.join(staging, 'node_modules'), path.join(appDirectory, 'node_modules'), { recursive: true, dereference: true });
  await cp(path.join(root, 'LICENSE.md'), path.join(appDirectory, 'LICENSE.md'));
  const resources = path.join(staging, 'bundle');
  await mkdir(resources, { recursive: true });
  await cp(coresDirectory, path.join(resources, 'cores'), { recursive: true });
  const desktopExecutable = process.platform === 'darwin' ? 'desktop/Vibe Editor.app/Contents/MacOS/Vibe Editor' : 'desktop/Vibe Editor.exe';
  await writeJson(path.join(resources, 'manifest.json'), { schema: 1, channel: 'early-access', version, commit, cores, ...(kind === 'gateway' ? { desktopExecutable } : {}) });
  if (desktopBundle) await cp(desktopBundle, path.join(resources, 'desktop'), { recursive: true });
  const name = kind === 'desktop' ? 'Vibe Editor' : 'Vibe Gateway';
  const [built] = await packager({ dir: appDirectory, out: path.join(output, 'apps'), name, appBundleId: `com.vibe-editor.${kind}`, appVersion: version, electronVersion, platform: process.platform, arch: process.arch, overwrite: true, prune: false, asar: false, extraResource: [resources], osxSign: process.platform === 'darwin' ? { identity: '-', identityValidation: false } : undefined });
  // Large portable runtimes are already copied into the finished app. Free the
  // staging tree before building Gateway, which also embeds the complete Desktop.
  await rm(staging, { recursive: true, force: true });
  const executable = process.platform === 'darwin' ? path.join(built, `${name}.app/Contents/MacOS`, name) : path.join(built, `${name}.exe`);
  await smokeApplication(executable);
  if (kind === 'gateway') {
    const resourcesRoot = process.platform === 'darwin' ? path.join(built, `${name}.app/Contents/Resources`) : path.join(built, 'resources');
    await smokeApplication(path.join(resourcesRoot, 'bundle', desktopExecutable));
  }
  if (kind === 'desktop') desktopBundle = built;
  const destination = path.join(output, 'downloads');
  await mkdir(destination, { recursive: true });
  const filename = `vibe-${kind}-${version}-${process.platform}-${process.arch}.zip`;
  const archive = path.join(destination, filename);
  if (process.platform === 'darwin') await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(built, `${name}.app`), archive]);
  else await run('tar', ['-a', '-cf', archive, '-C', built, ...await readdir(built)]);
  const digest = await sha256(archive);
  await writeJson(`${archive}.json`, { schema: 1, channel: 'early-access', version, commit, platform: process.platform, arch: process.arch, filename, sha256: digest });
}

async function smokeApplication(executable) {
  await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.VITE_DEV_SERVER_URL; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, ['--bundle-smoke-test'], { stdio: 'inherit', env });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Packaged app startup timed out: ${executable}`)); }, 60000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Packaged app startup failed (${code}): ${executable}`)); });
  });
}
