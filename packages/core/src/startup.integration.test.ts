import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { protocolCompatibility } from "@remote-ide/protocol";
import { createServer, shutdownCore } from "./server.js";

it("serves an authenticated protocol handshake while the initial workspace watcher is still scanning", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "vibe-startup-scan-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "vibe-startup-state-"));
  await promisify(execFile)("git", ["init", "-q", workspace]);
  vi.stubEnv("REMOTE_IDE_STATE_DIR", state);
  const pending = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) });
  const watch = vi.spyOn(chokidar, "watch").mockImplementationOnce(() => pending as unknown as ReturnType<typeof chokidar.watch>);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let socket: WebSocket | undefined;
  try {
    server = await createServer("127.0.0.1", 0, workspace, { access: { token: "startup-test-token-01234567890123456789" } });
    if (!server.address()) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send(JSON.stringify({ id: "health", type: "protocol.handshake", payload: { token: "startup-test-token-01234567890123456789", compatibility: protocolCompatibility } }));
    expect(JSON.parse(String((await response)[0]))).toMatchObject({ id: "health", ok: true, result: { compatible: true } });
    pending.emit("error", new Error("ENOSPC: native watch limit"));
    expect(server.address()).toBeTruthy();
  } finally {
    socket?.terminate();
    if (server) await shutdownCore(server);
    watch.mockRestore(); vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true }); await rm(state, { recursive: true, force: true });
  }
});
