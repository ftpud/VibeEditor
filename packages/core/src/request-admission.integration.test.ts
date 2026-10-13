import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { protocolCompatibility, type ProtocolOperations, type RequestType, type Response } from "@remote-ide/protocol";
import { WorkspaceFileSystem } from "./filesystem.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { TaskCheckpointStore } from "./task-checkpoints.js";
import { createServer } from "./server.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const releases: Array<() => void> = [];
let server: WebSocketServer | undefined;
let directory: string;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const socket of clients.splice(0)) if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed; }
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  directory = await mkdtemp(path.join(os.tmpdir(), "vibe-admission-"));
  const workspace = path.join(directory, "project"); await mkdir(workspace);
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  await promisify(execFile)("git", ["-C", workspace, "init", "-q"]);
  await writeFile(path.join(workspace, "file.txt"), "original");
  server = await createServer("127.0.0.1", 0, workspace, { admission: { maxInFlight: 2 } });
  if (!server.address()) await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`); clients.push(socket);
    const responses = new Map<string, Response>(); let sequence = 0; let rootId: string | undefined;
    socket.on("message", (data) => { const value = JSON.parse(data.toString()); if (value.id) responses.set(value.id, value); });
    await once(socket, "open");
    const send = <T extends RequestType>(type: T, payload: ProtocolOperations[T]["payload"]) => {
      const id = String(++sequence); socket.send(JSON.stringify({ id, type, payload, rootId })); return id;
    };
    const response = async (id: string) => { await vi.waitFor(() => expect(responses.has(id)).toBe(true), { timeout: 5000 }); return responses.get(id)!; };
    expect(await response(send("protocol.handshake", { compatibility: protocolCompatibility }))).toMatchObject({ ok: true });
    const roots = await response(send("workspace.roots", {})); if (!roots.ok) throw new Error("No roots");
    rootId = (roots.result as ProtocolOperations["workspace.roots"]["result"]).selectedRootId;
    return { socket, send, response, responses };
  };
  return { workspace, connect };
}

it("holds exactly the configured service concurrency, rejects excess mutations, and isolates healthy peers", async () => {
  const { workspace, connect } = await setup(); const slow = await connect(); const healthy = await connect();
  const gate = deferred(); releases.push(gate.resolve);
  const original = WorkspaceFileSystem.prototype.read;
  let active = 0; let peak = 0;
  const reads = vi.spyOn(WorkspaceFileSystem.prototype, "read").mockImplementation(async function (this: WorkspaceFileSystem, file) {
    if (file.startsWith("held")) { active++; peak = Math.max(peak, active); await gate.promise; active--; }
    return original.call(this, file === "held-error" ? "missing" : file.startsWith("held") ? "file.txt" : file);
  });
  const writes = vi.spyOn(WorkspaceFileSystem.prototype, "write");
  const first = slow.send("filesystem.readFile", { path: "held-ok" });
  const second = slow.send("filesystem.readFile", { path: "held-error" });
  await vi.waitFor(() => expect(active).toBe(2));
  for (let i = 0; i < 20; i++) {
    const id = slow.send("filesystem.writeFile", { path: "file.txt", content: "must not run", force: true });
    expect(await slow.response(id)).toMatchObject({ id, ok: false, error: { code: "INVALID_REQUEST", message: expect.stringContaining("not started") } });
  }
  expect(writes).not.toHaveBeenCalled(); expect(peak).toBe(2); expect(reads).toHaveBeenCalledTimes(2);
  expect(await slow.response(slow.send("protocol.keepAlive", {}))).toMatchObject({ ok: true });
  expect(await healthy.response(healthy.send("filesystem.readFile", { path: "file.txt" }))).toMatchObject({ ok: true, result: { content: "original" } });
  gate.resolve();
  expect(await slow.response(first)).toMatchObject({ id: first, ok: true });
  expect(await slow.response(second)).toMatchObject({ id: second, ok: false });
  expect(await slow.response(slow.send("filesystem.writeFile", { path: "file.txt", content: "accepted", force: true }))).toMatchObject({ ok: true });
  expect(await slow.response(slow.send("filesystem.readFile", { path: "file.txt" }))).toMatchObject({ ok: true, result: { content: "accepted" } });
  expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("accepted");
}, 15000);

it.each(["initialization", "switch", "queued-switch"] as const)("does not begin a waiting mutation after close during %s", async (wait) => {
  const { workspace, connect } = await setup();
  const gate = deferred(); const entered = deferred(); releases.push(gate.resolve);
  if (wait === "initialization") {
    const original = TaskCheckpointStore.prototype.recover;
    vi.spyOn(TaskCheckpointStore.prototype, "recover").mockImplementation(async function (this: TaskCheckpointStore) { entered.resolve(); await gate.promise; return original.call(this); });
  }
  const client = await connect();
  const writes = vi.spyOn(WorkspaceFileSystem.prototype, "write");
  const originalSelect = WorkspaceTaskStore.prototype.select;
  const select = vi.spyOn(WorkspaceTaskStore.prototype, "select");
  if (wait !== "initialization") {
    select.mockImplementation(async function (this: WorkspaceTaskStore, id) { entered.resolve(); await gate.promise; return originalSelect.call(this, id); });
    client.send("tasks.switch", {});
  }
  await entered.promise;
  if (wait === "queued-switch") client.send("tasks.switch", {});
  else client.send("filesystem.writeFile", { path: "file.txt", content: "obsolete", force: true });
  if (wait === "initialization") client.send("tasks.switch", {});
  // This bypassed round trip confirms earlier messages entered the async listener.
  expect(await client.response(client.send("protocol.keepAlive", {}))).toMatchObject({ ok: true });
  expect(writes).not.toHaveBeenCalled();
  const closed = once(client.socket, "close"); client.socket.terminate(); await closed;
  const healthy = await connect(); // Separate admission state; initialization spy is released below.
  gate.resolve();
  expect(await healthy.response(healthy.send("filesystem.readFile", { path: "file.txt" }))).toMatchObject({ ok: true, result: { content: "original" } });
  expect(writes).not.toHaveBeenCalled();
  expect(select).toHaveBeenCalledTimes(wait !== "initialization" ? 1 : 0);
  expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe("original");
}, 15000);
