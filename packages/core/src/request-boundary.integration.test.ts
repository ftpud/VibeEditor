import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { protocolCompatibility } from "@remote-ide/protocol";
import { AiTimerService } from "./ai-timers.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { createServer, shutdownCore } from "./server.js";

it("rejects malformed mutations and unknown providers before creating tasks, cancelling timers or moving files", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "request-boundary-")));
  vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let socket: WebSocket | undefined;
  const createTask = vi.spyOn(WorkspaceTaskStore.prototype, "createRandom");
  const cancelTimers = vi.spyOn(AiTimerService.prototype, "cancelWorkspace");
  try {
    await promisify(execFile)("git", ["init", directory]);
    await writeFile(path.join(directory, "preserved.txt"), "preserved");
    server = await createServer("127.0.0.1", 0, directory);
    socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`);
    await once(socket, "open");
    let sequence = 0;
    const request = async (type: string, payload: unknown, rootId?: string) => {
      const id = String(++sequence);
      const reply = new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => { socket!.off("message", message); reject(new Error(`No response to ${type}`)); }, 3_000);
        const message = (data: WebSocket.RawData) => {
          const value = JSON.parse(data.toString());
          if (value.id !== id) return;
          clearTimeout(timer); socket!.off("message", message); resolve(value);
        };
        socket!.on("message", message);
      });
      socket!.send(JSON.stringify({ id, type, payload, rootId }));
      return reply;
    };
    expect(await request("protocol.handshake", { compatibility: protocolCompatibility })).toMatchObject({ ok: true });
    const rootId = (await request("workspace.roots", {})).result.selectedRootId as string;
    const cases: [string, unknown][] = [
      ["tasks.delete", { taskId: "unknown-task" }],
      ["tasks.delete", { taskId: "../../outside" }],
      ["tasks.create", { branch: "unwanted", existing: "false" }],
      ["tasks.createFromPrompt", { provider: "unregistered-provider", prompt: "Do not create a task", configuration: {} }],
      ["tasks.createFromPrompt", { prompt: 1, configuration: {} }],
      ["filesystem.transferApply", { kind: "move", items: [{ source: "preserved.txt", destination: "moved.txt" }], confirmed: "false" }],
      ["filesystem.remoteTransferBegin", { direction: "upload", path: "preserved.txt", size: 4, overwrite: "false" }],
      ["tasks.list", []],
    ];
    for (const [type, payload] of cases) expect(await request(type, payload, rootId)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(createTask).not.toHaveBeenCalled();
    expect(cancelTimers).not.toHaveBeenCalled();
    expect((await request("tasks.list", {}, rootId)).result.tasks).toEqual([]);
    expect(await readFile(path.join(directory, "preserved.txt"), "utf8")).toBe("preserved");
    await expect(readFile(path.join(directory, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await request("protocol.keepAlive", {})).toMatchObject({ ok: true });
  } finally {
    socket?.terminate();
    if (server) await shutdownCore(server);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
