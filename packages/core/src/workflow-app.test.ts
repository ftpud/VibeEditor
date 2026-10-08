import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAppOptions, HarnessBlock } from "@remote-ide/protocol";
import { WorkflowAppService } from "./workflow-app.js";

const services: WorkflowAppService[] = [];
const directories: string[] = [];
afterEach(async () => { services.splice(0).forEach((service) => service.closeAll()); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "workflow-app-")); directories.push(workspace);
  const service = new WorkflowAppService(); services.push(service);
  const execute = async (action: NonNullable<HarnessAppOptions["action"]>, extra: Partial<HarnessBlock> = {}, input = "", target = workspace) => {
    const block: HarnessBlock = { id: action, type: "run_app", label: action, prompt: "", position: { x: 0, y: 0 }, app: { action, name: "server", lines: 2 }, ...extra };
    const result = await service.execute(block, input, target, () => {});
    return JSON.parse(result.messages[0]!.text) as { status: string; pid: number; output: string; exitCode: number | null; signal: string | null };
  };
  return { service, workspace, execute };
}

describe("workflow apps", () => {
  it("starts without waiting, keeps the app alive, tails both streams, reuses starts, and kills it", async () => {
    const { execute, workspace } = await setup();
    const script = 'printf "old\\ninput:%s\\n" "$VIBE_WORKFLOW_INPUT"; pwd; printf "error\\n" >&2; sleep 300 & wait';
    const started = await execute("start", { command: script }, "hello");
    expect(started).toMatchObject({ status: "running" });
    await vi.waitFor(async () => expect((await execute("tail", { app: { name: "server", action: "tail", lines: 10 } })).output).toContain(workspace));
    const tail = await execute("tail");
    expect(tail.output.split("\n")).toHaveLength(2);
    expect((await execute("tail", { app: { name: "server", action: "tail", lines: 10 } })).output).toContain("input:hello");
    expect((await execute("tail", { app: { name: "server", action: "tail", lines: 10 } })).output).toContain("error");
    expect((await execute("start", { command: script })).pid).toBe(started.pid);
    expect((await execute("status")).status).toBe("running");
    expect(await execute("kill")).toMatchObject({ status: "exited", signal: "SIGKILL" });
    expect((await execute("tail")).output).toBe(tail.output);
    expect((await execute("kill")).status).toBe("exited");
    const restarted = await execute("start", { command: "exec sleep 300" });
    expect(restarted.pid).not.toBe(started.pid);
  });

  it("uses one block for allowed actions and rejects disabled actions", async () => {
    const { execute } = await setup();
    const appBlock = { command: "printf 'ready\\n'; exec sleep 300", app: { name: "server", actions: ["start", "status", "tail", "kill"] as const, lines: 2 } };
    const configured = { ...appBlock, app: { ...appBlock.app, actions: [...appBlock.app.actions] } };
    expect((await execute("start", configured)).status).toBe("running");
    expect((await execute("start", configured, JSON.stringify({ action: "status" }))).status).toBe("running");
    await vi.waitFor(async () => expect((await execute("start", configured, JSON.stringify({ action: "tail" }))).output).toBe("ready"));
    await expect(execute("start", { app: { name: "server", actions: ["status"] } }, JSON.stringify({ action: "kill" }))).rejects.toThrow("allowed");
    expect((await execute("start", configured, JSON.stringify({ action: "kill" }))).status).toBe("exited");
    await expect(execute("start", { app: { name: "server", actions: [] } })).rejects.toThrow("allowed");
  });

  it("records natural exits and scopes app names to a workspace", async () => {
    const { execute } = await setup();
    await execute("start", { command: "printf 'done\\n'; exit 7" });
    await vi.waitFor(async () => expect(await execute("status")).toMatchObject({ status: "exited", exitCode: 7 }));
    expect((await execute("tail")).output).toBe("done");
    expect((await execute("status", {}, "", "/another-workspace")).status).toBe("not_found");
    await expect(execute("tail", {}, "", "/another-workspace")).rejects.toThrow("has not been started");
  });

  it("rejects invalid commands, tail counts and failed spawns", async () => {
    const { execute } = await setup();
    await expect(execute("start", { command: "" })).rejects.toThrow("shell script");
    await expect(execute("tail", { app: { action: "tail", name: "server", lines: 0 } })).rejects.toThrow("Tail lines");
    await expect(execute("start", { command: "sleep 300" }, "", "/nonexistent-workflow-app-workspace")).rejects.toThrow();
  });

  it("kills managed processes when Core closes", async () => {
    const { execute, service } = await setup();
    const started = await execute("start", { command: "exec sleep 300" });
    service.closeAll();
    await vi.waitFor(() => expect(() => process.kill(started.pid, 0)).toThrow());
    await expect(execute("status")).rejects.toThrow("shutting down");
  });
});
