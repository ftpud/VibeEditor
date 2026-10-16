import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const runtime = path.resolve(process.argv[2]);
const node = path.join(runtime, 'bin/node');
const require = createRequire(path.join(runtime, 'package.json'));
const { WebSocket } = require('ws');
const { protocolCompatibility } = await import(pathToFileURL(path.join(runtime, 'packages/protocol/dist/index.js')));
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'vibe-bundle-smoke-'));
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const token = 'a'.repeat(64);
let child;
let output = '';
async function handshake() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Handshake timed out')); }, 1000);
    const done = (error, result) => { clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(result); };
    socket.on('error', error => done(error));
    socket.on('open', () => socket.send(JSON.stringify({ id: 'smoke', type: 'protocol.handshake', payload: { compatibility: protocolCompatibility, token } })));
    socket.on('message', data => {
      const result = JSON.parse(String(data));
      if (result.id === 'smoke') {
        if (!result.ok || !result.result?.compatible) return done(null, result);
        socket.send(JSON.stringify({ id: 'roots', type: 'workspace.roots', payload: {} }));
      } else if (result.id === 'roots') {
        if (!result.ok || !result.result?.selectedRootId) return done(new Error(`Portable workspace lookup failed: ${JSON.stringify(result)}`));
        // Polling usage before provider installation must work without vendor
        // packages and must not trigger an on-demand runtime download.
        socket.send(JSON.stringify({ id: 'usage', type: 'ai.usage', rootId: result.result.selectedRootId, payload: { provider: 'codex' } }));
      } else if (result.id === 'usage') {
        if (!result.ok || !result.result?.usage) return done(new Error(`Portable Codex usage failed: ${JSON.stringify(result)}`));
        done(null, { ok: true, result: { compatible: true } });
      }
    });
  });
}
try {
  execFileSync('git', ['init', '--quiet', sandbox]);
  execFileSync('git', ['-C', sandbox, '-c', 'user.name=Bundle Smoke', '-c', 'user.email=bundle@example.invalid', 'commit', '--allow-empty', '-m', 'Initial']);
  await promisify(execFile)(node, ['--input-type=commonjs', '-e', `
    const pty = require('node-pty');
    let output = '';
    const terminal = pty.spawn('/bin/sh', ['-c', 'printf bundle-pty-ok'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    const timeout = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 5000);
    terminal.onData(data => output += data);
    terminal.onExit(({ exitCode }) => { clearTimeout(timeout); if (exitCode !== 0 || !output.includes('bundle-pty-ok')) process.exitCode = 1; });
  `], { cwd: runtime, timeout: 10000 });
  // Repeat startup against durable state using only the staged runtime.
  for (let cycle = 0; cycle < 2; cycle++) {
    child = spawn(node, [path.join(runtime, 'packages/core/dist/index.js'), '--host', '127.0.0.1', '--port', String(port), '--workspace', sandbox], {
      cwd: sandbox,
      env: { ...process.env, PATH: `${path.join(runtime, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, REMOTE_IDE_STATE_DIR: path.join(sandbox, 'state'), REMOTE_IDE_SESSION_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', error => { output += String(error); });
    const deadline = Date.now() + 30000;
    let result;
    while (Date.now() < deadline && child.exitCode === null) {
      try { result = await handshake(); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(result?.ok, true, output);
    assert.equal(result?.result?.compatible, true, output);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { const [code] = await exited; assert.equal(code, 0, output); } finally { clearTimeout(timeout); }
  }
  const manifest = JSON.parse(await readFile(path.join(runtime, 'bundle.json'), 'utf8'));
  console.log(`Portable Core passed startup, authenticated protocol and restart checks: ${manifest.target}`);
} finally { child?.kill('SIGKILL'); await rm(sandbox, { recursive: true, force: true }); }
