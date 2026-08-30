import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfigService } from "./run-configs.js";
import type { TerminalSessionHost } from "./process-manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibe-run-config-")); roots.push(root);
  const workspace = path.join(root, "workspace"); const state = path.join(root, "state"); await mkdir(workspace);
  const terminal = { create: vi.fn(() => ({ terminalId: "terminal-1", status: "running", output: "" })), input: vi.fn(), terminate: vi.fn() } as unknown as TerminalSessionHost;
  const changed = vi.fn(); const service = new RunConfigService(terminal, changed, workspace, state); return { root, workspace, global: service.directory(workspace, "global"), local: service.directory(workspace, "local"), terminal, changed, service };
}

describe("RunConfigService", () => {
  it("discovers both scopes without executing and preserves colliding names", async () => {
    const { service, workspace, global, local, terminal } = await fixture(); await mkdir(global, { recursive: true }); await mkdir(local, { recursive: true });
    await writeFile(path.join(global, "dev.sh"), "echo global\n"); await writeFile(path.join(local, "dev.sh"), "echo local\n");
    expect(await service.list(workspace)).toMatchObject([{ name: "dev", scope: "global", commands: "echo global\n" }, { name: "dev", scope: "local", commands: "echo local\n" }]);
    expect(terminal.create).not.toHaveBeenCalled();
  });
  it("rejects unsafe names and duplicate active runs, associates a terminal, and records exit", async () => {
    const { service, workspace, terminal } = await fixture(); await expect(service.create(workspace, "local", "../bad", "echo no")).rejects.toThrow("plain file name");
    await service.create(workspace, "local", "dev", "printf 'faithful'"); const running = await service.run(workspace, "local", "dev"); expect(running).toMatchObject({ status: "running", terminalId: "terminal-1" });
    expect(terminal.input).toHaveBeenCalledWith(workspace, "terminal-1", "printf 'faithful'\nexit $?\n"); await expect(service.run(workspace, "local", "dev")).rejects.toThrow("already active");
    service.onTerminalEvent({ type: "exit", workspace, terminalId: "terminal-1", exitCode: 0 }); expect(await service.read(workspace, "local", "dev")).toMatchObject({ status: "succeeded", exitCode: 0 });
  });
  it("marks an active run interrupted when its terminal is explicitly closed", async () => {
    const { service, workspace } = await fixture(); await service.create(workspace, "local", "watch", "sleep 10"); await service.run(workspace, "local", "watch");
    service.onTerminalClosed(workspace, "terminal-1"); expect(await service.read(workspace, "local", "watch")).toMatchObject({ status: "failed", exitCode: 130 });
  });
  it("renames and deletes idle configurations", async () => {
    const { service, workspace } = await fixture(); await service.create(workspace, "local", "old", "echo hi\n");
    expect(await service.rename(workspace, "local", "old", "new")).toMatchObject({ name: "new", commands: "echo hi\n" }); await expect(service.read(workspace, "local", "old")).rejects.toThrow("not found");
    await service.delete(workspace, "local", "new"); await expect(service.read(workspace, "local", "new")).rejects.toThrow("not found");
  });
});
