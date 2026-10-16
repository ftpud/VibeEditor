import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const output = path.join(root, 'artifacts');
export const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
export const writeJson = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
export function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    delete childEnv.npm_config_allow_scripts;
    const child = spawn(command, args, { cwd, env: childEnv, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

// Install the lockfile's production closure in isolation; never ship the checkout,
// development dependencies, credentials, or host node_modules.
export async function stageWorkspace(destination, workspace) {
  await mkdir(destination, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'LICENSE.md']) await cp(path.join(root, file), path.join(destination, file));
  for (const name of ['acp', 'protocol', 'core', 'desktop', 'gateway']) {
    const target = path.join(destination, 'packages', name);
    await mkdir(target, { recursive: true });
    await cp(path.join(root, 'packages', name, 'package.json'), path.join(target, 'package.json'));
  }
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspace', `@remote-ide/${workspace}`, '--include-workspace-root=false'], destination);
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
