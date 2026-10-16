import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";

// Exercises built Core in an isolated fixture, with an immutable application
// snapshot so a concurrent source build cannot change the code under test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (!["--cycles", "--minutes", "--pause-ms", "--request-timeout-ms", "--output"].includes(key) || !args[index + 1]) throw new Error("Usage: node scripts/release-soak.mjs [--cycles 20] [--minutes 30] [--pause-ms 250] [--request-timeout-ms 30000] [--output report.json]");
  options[key.slice(2)] = args[index + 1];
}
function positiveOption(key, fallback, minimum = 1) {
  const value = options[key] === undefined ? fallback : Number(options[key]);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid --${key}`);
  return value;
}
const cycles = options.cycles === undefined && options.minutes !== undefined ? Infinity : positiveOption("cycles", 20);
if (cycles !== Infinity && !Number.isSafeInteger(cycles)) throw new Error("--cycles must be an integer");
const duration = options.minutes === undefined ? Infinity : positiveOption("minutes", 30, 0.001) * 60_000;
const pauseMs = positiveOption("pause-ms", 250, 0);
const requestTimeoutMs = positiveOption("request-timeout-ms", 30_000);
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs > 120_000) throw new Error("--request-timeout-ms must be an integer from 1 to 120000");
const reportPath = path.resolve(options.output ?? path.join(os.tmpdir(), `vibe-release-soak-${Date.now()}-${process.pid}.json`));
const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "vibe-release-soak-")));
const runtime = path.join(sandbox, "runtime");
const workspace = path.join(sandbox, "workspace");
const tokenFile = path.join(sandbox, "credentials", "core.token");
const logPath = path.join(sandbox, "core.log");
const results = [];
const requestTimings = {};
const slowRequests = [];
let activeCycle = 0;
let current;
let interrupted = false;
const interrupt = () => { interrupted = true; current?.child.kill("SIGTERM"); };
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function linkDependencies(source, destination) {
  const entries = await readdir(source).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  await mkdir(destination, { recursive: true });
  await Promise.all(entries.filter((name) => name !== "@remote-ide").map((name) => symlink(path.join(source, name), path.join(destination, name))));
}
async function snapshotRuntime() {
  for (const name of ["acp", "protocol", "core"]) {
    const source = path.join(root, "packages", name);
    const destination = path.join(runtime, "packages", name);
    await access(path.join(source, "dist", "index.js")).catch(() => { throw new Error("Build the application with npm run build before running the release soak"); });
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true });
    await cp(path.join(source, "package.json"), path.join(destination, "package.json"));
    await linkDependencies(path.join(source, "node_modules"), path.join(destination, "node_modules"));
  }
  await linkDependencies(path.join(root, "node_modules"), path.join(runtime, "node_modules"));
  const scope = path.join(runtime, "node_modules", "@remote-ide");
  await mkdir(scope, { recursive: true });
  for (const name of ["acp", "protocol"]) await symlink(path.join(runtime, "packages", name), path.join(scope, name));
  // Local workspace dependency links must resolve to the same frozen code too.
  for (const name of ["acp", "protocol", "core"]) {
    const localScope = path.join(runtime, "packages", name, "node_modules", "@remote-ide");
    await mkdir(localScope, { recursive: true });
    for (const dependency of ["acp", "protocol"]) await symlink(path.join(runtime, "packages", dependency), path.join(localScope, dependency));
  }
}
async function runtimeDigest() {
  const entries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) entries.push([path.relative(runtime, file), createHash("sha256").update(await readFile(file)).digest("hex")]);
    }
  }
  await visit(path.join(runtime, "packages"));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function rpc(socket) {
  let sequence = 0;
  const pending = new Map();
  socket.on("error", () => {});
  socket.on("message", (data) => {
    let response;
    try { response = JSON.parse(String(data)); } catch { return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    const elapsedMs = Date.now() - request.started;
    requestTimings[request.type] = Math.max(requestTimings[request.type] ?? 0, elapsedMs);
    if (elapsedMs >= 1_000 && slowRequests.length < 100) slowRequests.push({ cycle: activeCycle, type: request.type, elapsedMs });
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error?.message ?? "Core request failed"));
  });
  socket.on("close", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Core disconnected")); }
    pending.clear();
  });
  return (type, payload, rootId) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    const started = Date.now();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Core request timed out: ${type} (id ${id}, cycle ${activeCycle}, ${Date.now() - started}ms)`)); }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer, type, started });
    socket.send(JSON.stringify({ id, type, payload, ...(rootId ? { rootId } : {}) }), (error) => {
      if (error && pending.delete(id)) { clearTimeout(timer); reject(error); }
    });
  });
}
async function startCore(port, log, compatibility) {
  const child = spawn(process.execPath, [path.join(runtime, "packages/core/dist/index.js"), "--host", "127.0.0.1", "--port", String(port), "--workspace", workspace], {
    cwd: workspace,
    env: { ...process.env, REMOTE_IDE_STATE_DIR: path.join(sandbox, "state"), REMOTE_IDE_SESSION_TOKEN: "", REMOTE_IDE_SESSION_TOKEN_FILE: tokenFile },
    stdio: ["ignore", log.fd, log.fd],
  });
  const exited = new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  void exited.catch(() => undefined);
  current = { child, exited };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Release soak interrupted");
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Core exited before startup; inspect ${logPath}`);
    let socket;
    try {
      const token = (await readFile(tokenFile, "utf8")).trim();
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.on("error", () => {});
      await bounded(once(socket, "open"), 1_000, "Core listener not ready");
      const request = rpc(socket);
      const handshake = await request("protocol.handshake", { compatibility, token });
      assert.equal(handshake.compatible, true);
      const { selectedRootId } = await request("workspace.roots", {});
      return { child, exited, socket, request, rootId: selectedRootId };
    } catch (error) {
      socket?.terminate();
      if (error.code !== "ENOENT" && child.exitCode !== null) throw error;
      await delay(50);
    }
  }
  throw new Error(`Core did not become ready; inspect ${logPath}`);
}
async function stopCore(connection, signal) {
  connection.child.kill(signal);
  const result = await bounded(connection.exited, 35_000, "Core failed to exit within shutdown deadline");
  connection.socket.terminate(); current = undefined;
  if (signal === "SIGKILL") assert.equal(result.signal, "SIGKILL");
  else assert.deepEqual(result, { code: 0, signal: null });
}
async function rssKiB(pid) {
  if (process.platform === "linux") return Number((await readFile(`/proc/${pid}/status`, "utf8")).match(/^VmRSS:\s+(\d+)/m)?.[1]) || undefined;
  return Number((await exec("ps", ["-p", String(pid), "-o", "rss="])).stdout.trim()) || undefined;
}
const report = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, requestTimeoutMs, results };
let log;
try {
  await snapshotRuntime();
  const { protocolCompatibility } = await import(pathToFileURL(path.join(runtime, "packages/protocol/dist/index.js")).href);
  report.protocol = protocolCompatibility;
  report.runtimeArtifactSha256 = await runtimeDigest();
  report.coreArtifactSha256 = createHash("sha256").update(await readFile(path.join(runtime, "packages/core/dist/server.js"))).digest("hex");
  await mkdir(workspace); await writeFile(path.join(workspace, "README.md"), "Release soak fixture\n");
  await exec("git", ["init", "-q", workspace]);
  await exec("git", ["-C", workspace, "add", "README.md"]);
  await exec("git", ["-C", workspace, "-c", "user.name=Release Soak", "-c", "user.email=soak@example.invalid", "commit", "-qm", "fixture"]);
  log = await open(logPath, "a", 0o600);
  const port = await freePort();
  const started = Date.now();
  let expected;
  for (let index = 0; index < cycles && Date.now() - started < duration; index++) {
    activeCycle = index + 1;
    const connection = await startCore(port, log, protocolCompatibility);
    const opened = await connection.request("workspace.open", {}, connection.rootId);
    if (expected) {
      assert.ok(expected.has(opened.options.gitCommitMessage), "Restart lost an acknowledged state update or reset options");
      assert.deepEqual(opened.options.openFiles, ["README.md"]);
    }
    let acknowledged;
    for (let write = 0; write < 5; write++) {
      acknowledged = `cycle-${index}-ack-${write}`;
      await connection.request("workspace.saveOptions", { options: { openFiles: ["README.md"], gitCommitMessage: acknowledged } }, connection.rootId);
    }
    expected = new Set([acknowledged]);
    const pending = [];
    for (let write = 0; write < 5; write++) {
      const message = `cycle-${index}-pending-${write}`; expected.add(message);
      pending.push(connection.request("workspace.saveOptions", { options: { openFiles: ["README.md"], gitCommitMessage: message } }, connection.rootId).catch(() => undefined));
    }
    await delay(10);
    const rss = await rssKiB(connection.child.pid);
    const signal = ["SIGTERM", "SIGINT", "SIGKILL"][index % 3];
    await stopCore(connection, signal); await Promise.all(pending);
    const result = { cycle: index + 1, signal, rssKiB: rss, elapsedMs: Date.now() - started };
    results.push(result); console.log(JSON.stringify(result));
    await delay(pauseMs);
  }
  assert.ok(results.length > 0, "No restart cycles completed");
  const verification = await startCore(port, log, protocolCompatibility);
  const finalState = await verification.request("workspace.open", {}, verification.rootId);
  assert.ok(expected.has(finalState.options.gitCommitMessage), "Final restart lost acknowledged options");
  assert.deepEqual(finalState.options.openFiles, ["README.md"]);
  await stopCore(verification, "SIGTERM");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.message : String(error);
  report.diagnosticsDirectory = sandbox; report.activeCycle = activeCycle;
  if (current && process.platform === "linux") {
    report.coreProcess = { pid: current.child.pid };
    for (const name of ["status", "io", "wchan"]) {
      report.coreProcess[name] = await readFile(`/proc/${current.child.pid}/${name}`, "utf8").catch(() => "unavailable");
    }
    const threads = await readdir(`/proc/${current.child.pid}/task`).catch(() => []);
    report.coreProcess.threadWaitChannels = await Promise.all(threads.map(async (tid) => ({
      tid: Number(tid), wchan: await readFile(`/proc/${current.child.pid}/task/${tid}/wchan`, "utf8").catch(() => "unavailable"),
    })));
  }
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  if (current) { current.child.kill("SIGKILL"); await bounded(current.exited, 5_000, "Failed to clean up Core").catch(() => undefined); }
  await log?.close();
  report.completedAt = new Date().toISOString(); report.cycles = results.length;
  report.maxRequestLatencyMs = requestTimings; report.slowRequests = slowRequests;
  report.peakCoreRssKiB = Math.max(0, ...results.map((result) => result.rssKiB ?? 0));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  if (report.passed) await rm(sandbox, { recursive: true, force: true });
  console.log(`Release soak ${report.passed ? "passed" : "failed"}: ${results.length} cycles; report: ${reportPath}`);
  if (report.error) console.error(report.error);
}
