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

/** Keep only a workspace's actual Node runtime closure, not renderer/build/provider tools. */
export async function pruneRuntimeDependencies(destination, dependencies) {
  const { realpath, readdir, rm } = await import('node:fs/promises');
  destination = await realpath(destination);
  const keep = new Set();
  const visited = new Set();
  async function visit(name, from, optional = false) {
    let cursor = from;
    let directory;
    while (cursor === destination || cursor.startsWith(`${destination}${path.sep}`)) {
      const candidate = path.join(cursor, 'node_modules', name);
      try { await readFile(path.join(candidate, 'package.json')); directory = candidate; break; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!directory) { if (optional) return; throw new Error(`Missing runtime dependency: ${name}`); }
    keep.add(directory);
    directory = await realpath(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const metadata = await json(path.join(directory, 'package.json'));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await visit(dependency, directory, !!metadata.optionalDependencies?.[dependency]);
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) await visit(dependency, directory, true);
    for (const dependency of Object.keys(metadata.peerDependencies ?? {})) await visit(dependency, directory, !!metadata.peerDependenciesMeta?.[dependency]?.optional);
  }
  for (const name of dependencies) await visit(name, destination);
  async function prune(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) { await prune(target); continue; }
      if (!keep.has(target)) await rm(target, { recursive: true, force: true });
    }
  }
  await prune(path.join(destination, 'node_modules'));
}

/** Preserve framework links so the copied app stays relocatable. */
export async function copyBundledApplication(source, destination) {
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

/**
 * Vibe's UI is English-only; Chromium's other UI translations add ~60 MB per
 * Electron copy. Runs on the extracted Electron before the app is signed.
 */
export async function pruneElectronLocales(buildPath, keep = ['en.lproj', 'en-US.pak']) {
  const { readdir, rm } = await import('node:fs/promises');
  const prune = async (directory, pattern) => {
    let entries;
    try { entries = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    const removed = entries.filter(name => pattern.test(name) && !keep.includes(name));
    await Promise.all(removed.map(name => rm(path.join(directory, name), { recursive: true, force: true })));
    return removed.length;
  };
  let removed = await prune(path.join(buildPath, 'locales'), /\.pak$/);
  for (const app of (await readdir(buildPath)).filter(name => name.endsWith('.app'))) {
    removed += await prune(path.join(buildPath, app, 'Contents/Resources'), /\.lproj$/);
    removed += await prune(path.join(buildPath, app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources'), /\.lproj$/);
  }
  if (!removed) throw new Error(`No Electron locales found to prune in ${buildPath}`);
}
