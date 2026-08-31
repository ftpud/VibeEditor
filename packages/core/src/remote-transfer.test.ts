import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RemoteTransferService } from "./remote-transfer.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN; OPEN = WebSocket.OPEN; close(code = 1000, reason = "") { this.readyState = WebSocket.CLOSED; this.emit("close", code, Buffer.from(reason)); } pause() {} resume() {} send() {}
}
class BackpressureSocket extends FakeSocket {
  sends = 0; callbacks: Array<(error?: Error) => void> = [];
  override send(_data?: unknown, _options?: unknown, callback?: (error?: Error) => void) { this.sends += 1; if (callback) this.callbacks.push(callback); }
}
const root = () => mkdtemp(path.join(os.tmpdir(), "vibe-transfer-"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("RemoteTransferService", () => {
  it("enforces the byte limit and refuses overwrite unless explicit", async () => { const workspace = await root(); await writeFile(path.join(workspace, "exists.bin"), "old"); const service = new RemoteTransferService(4); await expect(service.begin(workspace, { direction: "upload", path: "big.bin", size: 5 })).rejects.toThrow("limit"); await expect(service.begin(workspace, { direction: "upload", path: "exists.bin", size: 3 })).rejects.toThrow("explicitly allow overwrite"); await expect(service.begin(workspace, { direction: "upload", path: "exists.bin", size: 3, overwrite: true })).resolves.toMatchObject({ size: 3 }); });
  it("refuses traversal and symlink destinations", async () => { const workspace = await root(); const outside = await root(); await mkdir(path.join(workspace, "dir")); await symlink(outside, path.join(workspace, "dir", "link")); const service = new RemoteTransferService(); await expect(service.begin(workspace, { direction: "upload", path: "../escape", size: 1 })).rejects.toThrow("traversal"); await expect(service.begin(workspace, { direction: "upload", path: "dir/link/file", size: 1 })).rejects.toThrow("symlinks"); });
  it("commits exact uploads atomically with explicit permissions", async () => { const workspace = await root(); const service = new RemoteTransferService(); const ticket = await service.begin(workspace, { direction: "upload", path: "assets/file.bin", size: 4, mode: 0o600 }); const socket = new FakeSocket(); await service.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); socket.emit("message", Buffer.from("data"), true); socket.emit("message", Buffer.alloc(0), true); await tick(); expect(await readFile(path.join(workspace, "assets/file.bin"), "utf8")).toBe("data"); expect((await readdir(path.join(workspace, "assets"))).some((name) => name.includes("vibe-part"))).toBe(false); });
  it("never replaces a destination created before a no-overwrite commit", async () => { const workspace = await root(); const service = new RemoteTransferService(); const ticket = await service.begin(workspace, { direction: "upload", path: "claimed.bin", size: 4 }); const socket = new FakeSocket(); await service.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); socket.emit("message", Buffer.from("data"), true); await writeFile(path.join(workspace, "claimed.bin"), "other"); socket.emit("message", Buffer.alloc(0), true); await tick(); expect(await readFile(path.join(workspace, "claimed.bin"), "utf8")).toBe("other"); expect((await readdir(workspace)).some((name) => name.includes("vibe-part"))).toBe(false); });
  it("waits for each download send callback before reading another chunk", async () => { const workspace = await root(); await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(256 * 1024)); const service = new RemoteTransferService(); const ticket = await service.begin(workspace, { direction: "download", path: "large.bin" }); const socket = new BackpressureSocket(); await service.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); await tick(); expect(socket.sends).toBe(1); socket.callbacks.shift()?.(); await tick(); expect(socket.sends).toBe(2); socket.close(4000); });
  it("cancels active tickets and removes partial files", async () => { const workspace = await root(); const service = new RemoteTransferService(); const ticket = await service.begin(workspace, { direction: "upload", path: "partial.bin", size: 8 }); const socket = new FakeSocket(); await service.attach(socket as unknown as WebSocket, `/project-transfer?token=${ticket.token}`); socket.emit("message", Buffer.from("part"), true); expect(service.cancel(ticket.token)).toBe(true); await tick(); expect((await readdir(workspace)).some((name) => name.includes("vibe-part"))).toBe(false); });
});
