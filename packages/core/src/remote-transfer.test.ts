import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { RemoteTransferService } from "./remote-transfer.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN; OPEN = WebSocket.OPEN; close(code = 1000, reason = "") { this.readyState = WebSocket.CLOSED; this.emit("close", code, Buffer.from(reason)); } pause() {} resume() {} send() {}
}
class BackpressureSocket extends FakeSocket {
  sends = 0; callbacks: Array<(error?: Error) => void> = [];
  override send(_data?: unknown, _options?: unknown, callback?: (error?: Error) => void) { this.sends += 1; if (callback) this.callbacks.push(callback); }
}
const directories: string[] = [];
const services = new Set<RemoteTransferService>();
function service(...args: ConstructorParameters<typeof RemoteTransferService>): RemoteTransferService { const value = new RemoteTransferService(...args); services.add(value); return value; }
const root = async () => { const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-transfer-")); directories.push(directory); return directory; };
afterEach(async () => { await Promise.all([...services].map((value) => value.close())); services.clear(); vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("RemoteTransferService", () => {
  it("enforces the byte limit and refuses overwrite unless explicit", async () => { const workspace = await root(); await writeFile(path.join(workspace, "exists.bin"), "old"); const transfers = service(4); await expect(transfers.begin(workspace, { direction: "upload", path: "big.bin", size: 5 })).rejects.toThrow("limit"); await expect(transfers.begin(workspace, { direction: "upload", path: "exists.bin", size: 3 })).rejects.toThrow("explicitly allow overwrite"); await expect(transfers.begin(workspace, { direction: "upload", path: "exists.bin", size: 3, overwrite: true })).resolves.toMatchObject({ size: 3 }); });
  it("refuses traversal and symlink destinations", async () => { const workspace = await root(); const outside = await root(); await mkdir(path.join(workspace, "dir")); await symlink(outside, path.join(workspace, "dir", "link")); const transfers = service(); await expect(transfers.begin(workspace, { direction: "upload", path: "../escape", size: 1 })).rejects.toThrow("traversal"); await expect(transfers.begin(workspace, { direction: "upload", path: "dir/link/file", size: 1 })).rejects.toThrow("symlinks"); });
  it("commits exact uploads atomically with explicit permissions", async () => { const workspace = await root(); const transfers = service(); const ticket = await transfers.begin(workspace, { direction: "upload", path: "assets/file.bin", size: 4, mode: 0o600 }); const socket = new FakeSocket(); await transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); socket.emit("message", Buffer.from("data"), true); socket.emit("message", Buffer.alloc(0), true); await tick(); expect(await readFile(path.join(workspace, "assets/file.bin"), "utf8")).toBe("data"); expect((await readdir(path.join(workspace, "assets"))).some((name) => name.includes("vibe-part"))).toBe(false); });
  it("never replaces a destination created before a no-overwrite commit", async () => { const workspace = await root(); const transfers = service(); const ticket = await transfers.begin(workspace, { direction: "upload", path: "claimed.bin", size: 4 }); const socket = new FakeSocket(); await transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); socket.emit("message", Buffer.from("data"), true); await writeFile(path.join(workspace, "claimed.bin"), "other"); socket.emit("message", Buffer.alloc(0), true); await tick(); expect(await readFile(path.join(workspace, "claimed.bin"), "utf8")).toBe("other"); expect((await readdir(workspace)).some((name) => name.includes("vibe-part"))).toBe(false); });
  it("waits for each download send callback before reading another chunk", async () => { const workspace = await root(); await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(256 * 1024)); const transfers = service(); const ticket = await transfers.begin(workspace, { direction: "download", path: "large.bin" }); const socket = new BackpressureSocket(); await transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); await tick(); expect(socket.sends).toBe(1); socket.callbacks.shift()?.(); await tick(); expect(socket.sends).toBe(2); socket.close(4000); });
  it("cancels active tickets and removes partial files", async () => { const workspace = await root(); const transfers = service(); const ticket = await transfers.begin(workspace, { direction: "upload", path: "partial.bin", size: 8 }); const socket = new FakeSocket(); await transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); socket.emit("message", Buffer.from("part"), true); expect(transfers.cancel(ticket.token)).toBe(true); await tick(); expect((await readdir(workspace)).some((name) => name.includes("vibe-part"))).toBe(false); });
});

it("rejects truthy nonboolean overwrite approval before issuing a ticket", async () => {
  const workspace = await root(); await writeFile(path.join(workspace, "exists"), "preserved");
  const transfers = service();
  await expect(transfers.begin(workspace, { direction: "upload", path: "exists", size: 3, overwrite: "false" as unknown as boolean })).rejects.toThrow("overwrite must be a boolean");
  expect(await readFile(path.join(workspace, "exists"), "utf8")).toBe("preserved");
});

it("handles upload preparation errors without rejecting outside the socket handler", async () => {
  const workspace = await root(); const transfers = service();
  const ticket = await transfers.begin(workspace, { direction: "upload", path: "parent/file", size: 4 });
  await writeFile(path.join(workspace, "parent"), "not a directory");
  const socket = new FakeSocket(); const close = vi.spyOn(socket, "close");
  await expect(transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`)).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledWith(1011, "Could not prepare file transfer");
  expect(transfers.hasWorkspace(workspace)).toBe(false);
});

it.skipIf(process.getuid?.() === 0)("handles partial-file open errors without an unhandled stream error", async () => {
  const workspace = await root(); const parent = path.join(workspace, "readonly"); await mkdir(parent);
  const transfers = service(); const ticket = await transfers.begin(workspace, { direction: "upload", path: "readonly/file", size: 4 });
  await chmod(parent, 0o500);
  try {
    const socket = new FakeSocket();
    await expect(transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`)).resolves.toBeUndefined();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(transfers.hasWorkspace(workspace)).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  } finally { await chmod(parent, 0o700); }
});

it("cancels while asynchronous upload setup is still running without leaving a partial", async () => {
  const workspace = await root(); const transfers = service();
  const ticket = await transfers.begin(workspace, { direction: "upload", path: "parent/file", size: 4 });
  const socket = new FakeSocket();
  const attaching = transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`);
  expect(transfers.cancel(ticket.token)).toBe(true);
  await attaching;
  expect(transfers.hasWorkspace(workspace)).toBe(false);
  expect(await readdir(path.join(workspace, "parent"))).toEqual([]);
});

it("drains active upload cleanup on shutdown and rejects new tickets", async () => {
  const workspace = await root(); const transfers = service();
  const ticket = await transfers.begin(workspace, { direction: "upload", path: "partial", size: 8 });
  const socket = new FakeSocket(); await transfers.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`);
  socket.emit("message", Buffer.from("part"), true);
  await transfers.close();
  expect(await readdir(workspace)).toEqual([]);
  expect(transfers.hasWorkspace(workspace)).toBe(false);
  await expect(transfers.begin(workspace, { direction: "upload", path: "later", size: 1 })).rejects.toThrow("shutting down");
});

it("prunes expired unused tickets instead of blocking workspace operations indefinitely", async () => {
  const workspace = await root(); const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const transfers = service(undefined, 10);
  await transfers.begin(workspace, { direction: "upload", path: "unused", size: 0 });
  expect(transfers.hasWorkspace(workspace)).toBe(true);
  clock.mockReturnValue(1_011);
  expect(transfers.hasWorkspace(workspace)).toBe(false);
});

it("accepts an immediate binary burst over a real WebSocket before upload setup finishes", async () => {
  const workspace = await root(); const transfers = service();
  const contents = Buffer.alloc(256 * 1024, 0x61);
  const ticket = await transfers.begin(workspace, { direction: "upload", path: "nested/fast.bin", size: contents.length });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const errors: unknown[] = [];
  server.on("connection", (socket, request) => { void transfers.attach(socket, request.url).catch((error) => { errors.push(error); socket.terminate(); }); });
  let client: WebSocket | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!server.address()) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    client = new WebSocket(`ws://127.0.0.1:${port}/project-transfer?token=${ticket.token}`);
    await once(client, "open");
    const closed = once(client, "close");
    for (let offset = 0; offset < contents.length; offset += 16 * 1024) client.send(contents.subarray(offset, offset + 16 * 1024));
    client.send(Buffer.alloc(0));
    const [code] = await Promise.race([closed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Immediate upload did not finish")), 5_000); })]);
    expect(code).toBe(1000);
    expect(errors).toEqual([]);
    expect(await readFile(path.join(workspace, "nested/fast.bin"))).toEqual(contents);
    expect(await readdir(path.join(workspace, "nested"))).toEqual(["fast.bin"]);
  } finally {
    clearTimeout(timeout); client?.terminate(); await transfers.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10_000);
