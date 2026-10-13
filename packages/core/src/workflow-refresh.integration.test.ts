import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { protocolCompatibility, type HarnessRun, type Response } from "@remote-ide/protocol";
import { HarnessStore } from "./harnesses.js";
import { createServer } from "./server.js";

it("refreshes only the requested run without transferring historical output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-refresh-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  await promisify(execFile)("git", ["-C", workspace, "init", "-q"]);
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  const store = new HarnessStore(workspace);
  const current: HarnessRun = { id: "current", harnessId: "flow", harnessVersion: 1, input: "start", status: "cancelled", createdAt: new Date().toISOString(), workspace, binding: { rootWorkspace: workspace, workspace }, blocks: [] };
  await store.saveRun({ ...current, id: "history", status: "succeeded", blocks: [{ blockId: "old", status: "succeeded", output: "x".repeat(500_000) }] });
  await store.saveRun(current);
  let server: WebSocketServer | undefined;
  let socket: WebSocket | undefined;
  try {
    server = await createServer("127.0.0.1", 0, workspace);
    if (!server.address()) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const responses = new Map<string, Response>();
    socket.on("message", (data) => { const value = JSON.parse(data.toString()); if (value.id) responses.set(value.id, value); });
    await once(socket, "open");
    let sequence = 0;
    let rootId: string | undefined;
    const request = async (type: string, payload: unknown) => {
      const id = String(++sequence);
      socket!.send(JSON.stringify({ id, type, payload, rootId }));
      await vi.waitFor(() => expect(responses.has(id)).toBe(true));
      const response = responses.get(id)!;
      if (!response.ok) throw new Error(response.error.message);
      return response.result as { runs: HarnessRun[]; selectedRootId?: string };
    };
    await request("protocol.handshake", { compatibility: protocolCompatibility });
    rootId = (await request("workspace.roots", {})).selectedRootId;
    expect((await request("harnesses.runs", {})).runs).toHaveLength(2);
    const result = await request("harnesses.runs", { runId: "current" });
    expect(result.runs).toEqual([current]);
    expect(JSON.stringify(result).length).toBeLessThan(1000);
    expect((await request("harnesses.runs", { runId: "missing" })).runs).toEqual([]);
    expect((await request("harnesses.runs", { runId: "current", harnessId: "other" })).runs).toEqual([]);
  } finally {
    socket?.terminate();
    if (server) { for (const peer of server.clients) peer.terminate(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
