import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { protocolCompatibility, type WorkspaceOptions } from "@remote-ide/protocol";
import { WebSocket, type WebSocketServer } from "ws";
import { createServer, shutdownCore } from "./server.js";
import { WorkspaceStateStore } from "./workspace-state.js";

const exec = promisify(execFile);

function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function responseFor(socket: WebSocket, id: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("error", onError); socket.off("close", onClose); };
    const onMessage = (data: WebSocket.RawData) => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(data.toString()) as Record<string, unknown>; }
      catch { return; }
      if (value.id !== id) return;
      cleanup(); resolve(value);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error(`Socket closed before response ${id}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for response ${id}`)); }, timeoutMs);
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function request(socket: WebSocket, id: string, type: string, payload: unknown, rootId?: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const response = responseFor(socket, id, timeoutMs);
  socket.send(JSON.stringify({ id, type, payload, ...(rootId ? { rootId } : {}) }));
  return response;
}

async function selectedRootId(socket: WebSocket, id: string): Promise<string> {
  const response = await request(socket, id, "workspace.roots", {});
  const result = response.result as { selectedRootId?: unknown } | undefined;
  if (!response.ok || typeof result?.selectedRootId !== "string") throw new Error("Core did not return a selected workspace root");
  return result.selectedRootId;
}

async function openSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await within(new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  }), 5_000, "Timed out opening Core WebSocket");
  return socket;
}

async function makeGitWorkspace(directory: string): Promise<string> {
  const workspace = path.join(directory, "project");
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "shutdown test\n");
  await exec("git", ["init", "-q", workspace]);
  await exec("git", ["-C", workspace, "-c", "user.name=Core test", "-c", "user.email=core-test@example.invalid", "add", "README.md"]);
  await exec("git", ["-C", workspace, "-c", "user.name=Core test", "-c", "user.email=core-test@example.invalid", "commit", "-qm", "initial"]);
  return realpath(workspace);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

it("drains a gated workspace options write before shutdown and closes its WebSocket", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "core-shutdown-drain-"));
  const workspace = await makeGitWorkspace(directory);
  const stateDirectory = path.join(directory, "state");
  vi.stubEnv("REMOTE_IDE_STATE_DIR", stateDirectory);
  const sockets: WebSocket[] = [];
  let server: WebSocketServer | undefined;
  const enteredSave = deferred<void>();
  const releaseSave = deferred<void>();
  let shutdown: Promise<void> | undefined;
  let shutdownError: unknown;
  let shutdownCompleted = false;
  const originalSave = WorkspaceStateStore.prototype.save;
  const save = vi.spyOn(WorkspaceStateStore.prototype, "save").mockImplementation(async function (this: WorkspaceStateStore, options: WorkspaceOptions) {
    enteredSave.resolve();
    await releaseSave.promise;
    return originalSave.call(this, options);
  });

  try {
    server = await createServer("127.0.0.1", 0, workspace);
    if (!server.address()) await within(once(server, "listening").then(() => undefined), 5_000, "Core listener did not become ready");
    const port = (server.address() as net.AddressInfo).port;
    const socket = await openSocket(port); sockets.push(socket);
    expect(await request(socket, "handshake", "protocol.handshake", { compatibility: protocolCompatibility })).toMatchObject({ ok: true });
    const rootId = await selectedRootId(socket, "roots");

    socket.send(JSON.stringify({ id: "save", type: "workspace.saveOptions", rootId, payload: { options: { openFiles: ["README.md"], activeFile: "README.md" } satisfies WorkspaceOptions } }));
    await within(enteredSave.promise, 5_000, "workspace options write did not reach its persistence handler");

    shutdown = shutdownCore(server).then(() => { shutdownCompleted = true; }, (error: unknown) => { shutdownError = error; shutdownCompleted = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(shutdownCompleted).toBe(false);

    releaseSave.resolve();
    const socketClosed = new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) resolve();
      else socket.once("close", () => resolve());
    });
    await within(shutdown, 10_000, "Core shutdown did not finish after the write gate opened");
    await within(socketClosed, 3_000, "Core shutdown left its WebSocket open");
    expect(shutdownError).toBeUndefined();
    await expect(new WorkspaceStateStore(workspace, stateDirectory).load()).resolves.toMatchObject({ openFiles: ["README.md"], activeFile: "README.md" });
    expect(save).toHaveBeenCalledOnce();
  } finally {
    releaseSave.resolve();
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (server) await within(shutdown ?? shutdownCore(server), 10_000, "Core cleanup did not finish").catch(() => undefined);
    vi.unstubAllEnvs();
    save.mockRestore();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}, 20_000);

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not select a Core test port");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForReady(child: ChildProcess, output: () => string, port: number): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Core exited before readiness (${child.exitCode}): ${output()}`);
    const probe = net.createConnection({ host: "127.0.0.1", port });
    const connected = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => { probe.removeAllListeners(); probe.destroy(); resolve(value); };
      probe.once("connect", () => finish(true));
      probe.once("error", () => finish(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Core listener on port ${port}: ${output()}`);
}

async function assertPortReleased(port: number): Promise<void> {
  const probe = net.createServer();
  await within(new Promise<void>((resolve, reject) => probe.once("error", reject).listen(port, "127.0.0.1", resolve)), 3_000, `Port ${port} remained occupied after Core exit`);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}

it.each(["SIGTERM", "SIGINT"] as const)("flushes saved workspace state and exits cleanly on %s", async (signal) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "core-signal-shutdown-"));
  const workspace = await makeGitWorkspace(directory);
  const stateDirectory = path.join(directory, "state");
  const tokenFile = path.join(directory, "private", "session.token");
  const port = await freePort();
  const index = fileURLToPath(new URL("./index.ts", import.meta.url));
  const environment: NodeJS.ProcessEnv = { ...process.env, REMOTE_IDE_STATE_DIR: stateDirectory, REMOTE_IDE_SESSION_TOKEN_FILE: tokenFile, REMOTE_IDE_CODEX_AUTO_UPDATE: "0" };
  delete environment.REMOTE_IDE_SESSION_TOKEN;
  const child = spawn(process.execPath, ["--import", "tsx", index, "--host", "127.0.0.1", "--port", String(port), "--workspace", workspace], {
    cwd: path.resolve(path.dirname(index), ".."), env: environment, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (data: string) => { output += data; });
  child.stderr?.setEncoding("utf8").on("data", (data: string) => { output += data; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })));
  let socket: WebSocket | undefined;

  try {
    await waitForReady(child, () => output, port);
    const token = (await readFile(tokenFile, "utf8")).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    socket = await openSocket(port);
    let handshake: Record<string, unknown>;
    try {
      handshake = await request(socket, "handshake", "protocol.handshake", { compatibility: protocolCompatibility, token });
    } catch (error) {
      throw new Error(`Core token handshake failed: ${String(error)}\n${output}`);
    }
    expect(handshake).toMatchObject({ ok: true, result: { compatible: true } });
    const rootId = await selectedRootId(socket, "roots");
    const options: WorkspaceOptions = { openFiles: ["README.md"], activeFile: "README.md", pinnedFiles: ["README.md"] };
    expect(await request(socket, "save-options", "workspace.saveOptions", { options }, rootId)).toMatchObject({ ok: true });

    const socketClosed = new Promise<void>((resolve) => {
      if (!socket || socket.readyState === WebSocket.CLOSED) resolve();
      else socket.once("close", () => resolve());
    });
    child.kill(signal);
    const result = await within(exited, 15_000, `Core did not exit after ${signal}`);
    expect(result).toEqual({ code: 0, signal: null });
    await within(socketClosed, 3_000, `Core did not close its WebSocket after ${signal}`);
    await expect(new WorkspaceStateStore(workspace, stateDirectory).load()).resolves.toMatchObject(options);
    await assertPortReleased(port);
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await within(exited, 5_000, "Could not stop the Core child process during test cleanup").catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}, 25_000);

it.skipIf(process.platform === "win32")("accepts protocol traffic while npm runtime updates are stalled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "core-slow-runtime-"));
  const workspace = await makeGitWorkspace(directory);
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const marker = path.join(directory, "npm-started");
  await writeFile(path.join(bin, "npm"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.VIBE_TEST_NPM_MARKER, 'started'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const port = await freePort();
  const index = fileURLToPath(new URL("./index.ts", import.meta.url));
  const tokenFile = path.join(directory, "session.token");
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REMOTE_IDE_STATE_DIR: path.join(directory, "state"), REMOTE_IDE_CODEX_RUNTIME_DIR: path.join(directory, "runtime"), REMOTE_IDE_SESSION_TOKEN: "", REMOTE_IDE_SESSION_TOKEN_FILE: tokenFile, REMOTE_IDE_CODEX_AUTO_UPDATE: "1", VIBE_TEST_NPM_MARKER: marker };
  const child = spawn(process.execPath, ["--import", "tsx", index, "--host", "127.0.0.1", "--port", String(port), "--workspace", workspace], { cwd: path.resolve(path.dirname(index), ".."), env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += String(data); }); child.stderr.on("data", (data) => { output += String(data); });
  const exited = once(child, "exit");
  let socket: WebSocket | undefined;
  try {
    await waitForReady(child, () => output, port);
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started"));
    socket = await openSocket(port);
    const token = (await readFile(tokenFile, "utf8")).trim();
    expect(await request(socket, "health", "protocol.handshake", { token, compatibility: protocolCompatibility })).toMatchObject({ ok: true, result: { compatible: true } });
  } finally {
    socket?.terminate();
    if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
    await within(exited, 5_000, "Could not clean up stalled npm test").catch(() => undefined);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}, 20_000);
