import { chmod, cp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, output, json, writeJson, run, stageWorkspace, sha256 } from './common.mjs';

const target = `${process.platform}-${process.arch}`;
if (!['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(target)) throw new Error(`Unsupported Core target: ${target}`);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const release = `${commit}-node${process.versions.modules}-bundle-${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${target}`;
const staging = path.join(output, 'staging', `core-${target}`);
await rm(staging, { recursive: true, force: true });
await stageWorkspace(staging, 'core');
for (const name of ['acp', 'protocol', 'core']) await cp(path.join(root, 'packages', name, 'dist'), path.join(staging, 'packages', name, 'dist'), { recursive: true, filter: source => !/\.(test|integration\.test)\.(js|d\.ts)$/.test(source) });
for (const name of ['desktop', 'gateway']) await rm(path.join(staging, 'packages', name), { recursive: true, force: true });
// node-pty must match the shipped Node ABI, not Electron's ABI.
await run('npm', ['rebuild', 'node-pty'], staging);
if (process.platform === 'darwin') await chmod(path.join(staging, 'node_modules/node-pty/prebuilds', target, 'spawn-helper'), 0o755);
await mkdir(path.join(staging, 'bin'), { recursive: true });
await cp(process.execPath, path.join(staging, 'bin/node'));
await cp(path.resolve(path.dirname(process.execPath), '../LICENSE'), path.join(staging, 'NODE-LICENSE'));
await chmod(path.join(staging, 'bin/node'), 0o755);
const npmRoot = path.resolve(path.dirname(await realpath(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim())), '..');
await cp(npmRoot, path.join(staging, 'lib/node_modules/npm'), { recursive: true });
await symlink('../lib/node_modules/npm/bin/npm-cli.js', path.join(staging, 'bin/npm'));
await symlink('../lib/node_modules/npm/bin/npx-cli.js', path.join(staging, 'bin/npx'));
// The Java language server and JRE are architecture-specific runtime resources.
for (const name of ['jdtls', 'jre21']) await cp(path.join(root, '.tools', name), path.join(staging, '.tools', name), { recursive: true });
const java = path.join(staging, '.tools/jre21', process.platform === 'darwin' ? 'Contents/Home/bin/java' : 'bin/java');
await run(java, ['-version'], staging);
await run(path.join(staging, 'bin/npm'), ['--version'], staging, { ...process.env, PATH: `${path.join(staging, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` });
const manifest = { schema: 1, target, commit, release, nodeVersion: process.versions.node, version: (await json(path.join(root, 'package.json'))).version };
await writeJson(path.join(staging, 'bundle.json'), manifest);
await run(path.join(staging, 'bin/node'), ['--input-type=module', '-e', "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); require('node-pty'); await import('./packages/core/dist/server.js');"], staging);
await mkdir(path.join(output, 'cores'), { recursive: true });
await run(process.execPath, [path.join(root, 'scripts/bundle/smoke-core.mjs'), staging]);
const archive = path.join(output, 'cores', `core-${target}.tar.gz`);
await run('tar', ['-czf', archive, '-C', staging, '.']);
await writeJson(`${archive}.json`, { ...manifest, archive: path.basename(archive), sha256: await sha256(archive) });
