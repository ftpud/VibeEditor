import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { WebSocket, type WebSocketServer } from "ws";
import { protocolCompatibility } from "@remote-ide/protocol";
import net from "node:net";
import { TaskCheckpointStore } from "./task-checkpoints.js";
import { createServer, shutdownCore } from "./server.js";
import { WorkspaceFileSystem } from "./filesystem.js";

const exec = promisify(execFile);
it("authenticates before session initialization and rejects untrusted browser origins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-access-"));
  const workspace = path.join(directory, "project");
  const token = "a".repeat(64);
  const sockets: WebSocket[] = [];
  let server: WebSocketServer | undefined;
  const initialized = vi.spyOn(WorkspaceFileSystem.prototype, "initialize");
  try {
    await mkdir(workspace); await writeFile(path.join(workspace, "file.txt"), "content");
    await exec("git", ["init", workspace]);
    vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
    server = await createServer("127.0.0.1", 0, workspace, { access: { token } });
    if (!server.address()) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(socket);
      await once(socket, "open"); return socket;
    };
    const count = initialized.mock.calls.length;
    const unauthenticated = await connect();
    const rejected = once(unauthenticated, "message");
    unauthenticated.send(JSON.stringify({ id: "bad", type: "protocol.handshake", payload: { compatibility: protocolCompatibility, token: "b".repeat(64) } }));
    const [data] = await rejected;
    expect(JSON.parse(String(data))).toMatchObject({ id: "bad", ok: false, error: { message: expect.stringContaining("authentication failed") } });
    expect(initialized.mock.calls).toHaveLength(count);
    const rejectedOrigin = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://untrusted.test" }); sockets.push(rejectedOrigin);
    await expect(once(rejectedOrigin, "open")).rejects.toThrow(/403/);
    expect(initialized.mock.calls).toHaveLength(count);
    const authenticated = await connect();
    const accepted = once(authenticated, "message");
    authenticated.send(JSON.stringify({ id: "good", type: "protocol.handshake", payload: { compatibility: protocolCompatibility, token } }));
    expect(JSON.parse(String((await accepted)[0]))).toMatchObject({ id: "good", ok: true, result: { compatible: true } });
    await vi.waitFor(() => expect(initialized.mock.calls.length).toBeGreaterThan(count));
  } finally {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed.catch(() => undefined); }
    }
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    initialized.mockRestore(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}, 15_000);


it("does not expose its listener until startup can accept protocol handshakes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-startup-"));
  const workspace = path.join(directory, "project");
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const original = TaskCheckpointStore.prototype.recover;
  const recovery = vi.spyOn(TaskCheckpointStore.prototype, "recover").mockImplementation(async function (this: TaskCheckpointStore) {
    entered(); await gate; return original.call(this);
  });
  let startup: Promise<WebSocketServer> | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(workspace); await exec("git", ["init", workspace]);
    vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
    startup = createServer("127.0.0.1", port, workspace);
    await blocked;
    const acceptsEarly = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection({ host: "127.0.0.1", port });
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => { probe.destroy(); resolve(false); });
    });
    expect(acceptsEarly).toBe(false);
    release(); await startup;
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send(JSON.stringify({ id: "ready", type: "protocol.handshake", payload: { compatibility: protocolCompatibility } }));
    expect(JSON.parse(String((await response)[0]))).toMatchObject({ id: "ready", ok: true, result: { compatible: true } });
  } finally {
    release(); socket?.terminate();
    if (startup) await shutdownCore(await startup);
    recovery.mockRestore(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}, 15_000);

it("reports an occupied listener port as a startup failure and cleans up services", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-startup-port-"));
  const workspace = path.join(directory, "project");
  const occupied = net.createServer();
  try {
    await mkdir(workspace); await exec("git", ["init", workspace]);
    vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const port = (occupied.address() as net.AddressInfo).port;
    await expect(createServer("127.0.0.1", port, workspace)).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
