import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { protocolCompatibility, type Response } from "@remote-ide/protocol";
import { createServer } from "./server.js";

it("returns correlated initial/recovery snapshot errors and keeps the same connection usable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tree-wire-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  await promisify(execFile)("git", ["-C", workspace, "init", "-q"]);
  await writeFile(path.join(workspace, "a"), "a");
  await writeFile(path.join(workspace, "b"), "b");
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  vi.stubEnv("VIBE_TREE_MAX_NODES", "1");
  let server: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    server = await createServer("127.0.0.1", 0, workspace);
    if (!server.address()) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      sockets.push(socket);
      const responses = new Map<string, Response>();
      socket.on("message", (data) => { const value = JSON.parse(data.toString()); if (value.id) responses.set(value.id, value); });
      await once(socket, "open");
      let sequence = 0;
      let rootId: string | undefined;
      const request = async (type: string, payload = {}) => {
        const id = `${attempt}-${++sequence}`;
        socket.send(JSON.stringify({ id, type, payload, rootId }));
        await vi.waitFor(() => expect(responses.has(id)).toBe(true));
        return responses.get(id)!;
      };
      expect((await request("protocol.handshake", { compatibility: protocolCompatibility })).ok).toBe(true);
      const roots = await request("workspace.roots");
      if (!roots.ok) throw new Error("Roots failed");
      rootId = (roots.result as { selectedRootId: string }).selectedRootId;
      for (const type of ["workspace.open", "filesystem.listTree"]) {
        const rejected = await request(type);
        expect(rejected).toMatchObject({ ok: false, error: { code: "WORKSPACE_TREE_TOO_LARGE", message: expect.stringContaining("smaller workspace") } });
        expect(JSON.stringify(rejected).length).toBeLessThan(1024);
      }
      expect((await request("protocol.keepAlive")).ok).toBe(true);
      expect(await request("filesystem.readFile", { path: "a" })).toMatchObject({ ok: true, result: { content: "a" } });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server) { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
