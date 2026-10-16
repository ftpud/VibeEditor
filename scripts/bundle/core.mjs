import { chmod, cp, mkdir, mkdtemp, rm, symlink, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { root, output, json, writeJson, run, stageWorkspace, sha256, pruneRuntimeDependencies } from './common.mjs';

const target = `${process.platform}-${process.arch}`;
if (!['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(target)) throw new Error(`Unsupported Core target: ${target}`);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const release = `${commit}-node${process.versions.modules}-bundle-${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${target}`;
const staging = path.join(output, 'staging', `core-${target}`);
await rm(staging, { recursive: true, force: true });
await stageWorkspace(staging, 'core');
for (const name of ['acp', 'protocol', 'core']) await cp(path.join(root, 'packages', name, 'dist'), path.join(staging, 'packages', name, 'dist'), { recursive: true, filter: source => !/\.(test|integration\.test)\.(js|d\.ts)$/.test(source) });
for (const name of ['desktop', 'gateway']) await rm(path.join(staging, 'packages', name), { recursive: true, force: true });
// Provider ACP agents are installed on the Core host from Settings -> AI providers, not shipped.
const dependencies = Object.keys((await json(path.join(root, 'packages/core/package.json'))).dependencies);
await pruneRuntimeDependencies(staging, dependencies);
// node-pty must match the shipped Node ABI, not Electron's ABI.
await run('npm', ['rebuild', 'node-pty'], staging);
// node-pty publishes prebuilds for several OS/CPU pairs; ship this target only.
for (const entry of await (await import('node:fs/promises')).readdir(path.join(staging, 'node_modules/node-pty/prebuilds'))) {
  if (entry !== target) await rm(path.join(staging, 'node_modules/node-pty/prebuilds', entry), { recursive: true, force: true });
}
if (process.platform === 'darwin') await chmod(path.join(staging, 'node_modules/node-pty/prebuilds', target, 'spawn-helper'), 0o755);
await mkdir(path.join(staging, 'bin'), { recursive: true });
await cp(process.execPath, path.join(staging, 'bin/node'));
const nodeDirectory = path.resolve(path.dirname(process.execPath), '..');
const licenses = [path.join(nodeDirectory, 'LICENSE'), path.join(nodeDirectory, 'node_modules', `node-bin-${target}`, 'LICENSE'), path.join(nodeDirectory, 'node_modules', `node-${target}`, 'LICENSE')];
let copiedLicense = false;
for (const license of licenses) {
  try { await cp(license, path.join(staging, 'NODE-LICENSE')); copiedLicense = true; break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!copiedLicense) throw new Error('Could not locate the shipped Node runtime license');
await chmod(path.join(staging, 'bin/node'), 0o755);
const npmRoot = path.resolve(path.dirname(await realpath(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim())), '..');
await cp(npmRoot, path.join(staging, 'lib/node_modules/npm'), { recursive: true });
await symlink('../lib/node_modules/npm/bin/npm-cli.js', path.join(staging, 'bin/npm'));
await symlink('../lib/node_modules/npm/bin/npx-cli.js', path.join(staging, 'bin/npx'));
// The Java runtime and language server are downloaded on demand from Settings -> Tools.
await run(path.join(staging, 'bin/npm'), ['--version'], staging, { ...process.env, PATH: `${path.join(staging, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` });
const manifest = { schema: 1, target, commit, release, nodeVersion: process.versions.node, version: (await json(path.join(root, 'package.json'))).version };
await writeJson(path.join(staging, 'bundle.json'), manifest);
await run(path.join(staging, 'bin/node'), ['--input-type=module', '-e', "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); require('node-pty'); await import('./packages/core/dist/server.js');"], staging);
await mkdir(path.join(output, 'cores'), { recursive: true });
await run(process.execPath, [path.join(root, 'scripts/bundle/smoke-core.mjs'), staging]);
const archive = path.join(output, 'cores', `core-${target}.tar.gz`);
await run('tar', ['-czf', archive, '-C', staging, '.']);
// Verify the actual extracted archive outside the checkout so parent node_modules
// cannot hide an incomplete dependency closure.
const isolated = await mkdtemp(path.join(os.tmpdir(), 'vibe-portable-core-'));
try {
  await run('tar', ['-xzf', archive, '-C', isolated]);
  await run(process.execPath, [path.join(root, 'scripts/bundle/smoke-core.mjs'), isolated]);
} finally { await rm(isolated, { recursive: true, force: true }); }

await writeJson(`${archive}.json`, { ...manifest, archive: path.basename(archive), sha256: await sha256(archive) });
await rm(staging, { recursive: true, force: true });
