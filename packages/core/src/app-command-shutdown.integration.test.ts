import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { AppEventBridge, appBridgeInstanceId } from "./app-events.js";
import { AppToolService } from "./app-tools.js";
import { createServer, shutdownCore } from "./server.js";

it("drains an admitted MCP bridge command through its response before shutdown completes", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-shutdown-")));
  const workspace = path.join(directory, "project");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const call = vi.spyOn(AppToolService.prototype, "call").mockImplementation(async () => { entered(); await gate; return "completed"; });
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let command: Promise<unknown> | undefined;
  let shutdown: Promise<void> | undefined;
  try {
    await mkdir(workspace); await promisify(execFile)("git", ["init", workspace]);
    vi.stubEnv("REMOTE_IDE_STATE_DIR", path.join(directory, "state"));
    server = await createServer("127.0.0.1", 0, workspace);
    const bridge = new AppEventBridge(workspace, undefined, appBridgeInstanceId);
    command = bridge.call({ name: "test-admitted-command", args: {} }, 5_000);
    await started;
    let finished = false;
    shutdown = shutdownCore(server).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    release();
    await expect(command).resolves.toBe("completed");
    await shutdown;
    expect(finished).toBe(true);
  } finally {
    release();
    await command?.catch(() => undefined);
    if (server) await (shutdown ?? shutdownCore(server));
    call.mockRestore(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
