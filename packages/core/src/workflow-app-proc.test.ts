import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessBlock } from "@remote-ide/protocol";
import { WorkflowAppService } from "./workflow-app.js";
import { managedProcesses } from "./managed-processes.js";
import { listProjectApps, killProjectApp } from "./project-processes.js";

const services: WorkflowAppService[] = []; const directories: string[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.closeAll())); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "workflow-proc-")); directories.push(workspace);
  const service = new WorkflowAppService(); services.push(service);
  const tasks = { list: async () => ({ tasks: [] }), taskPath: () => workspace };
  const block: HarnessBlock = { id: "app", type: "run_app", label: "Server", prompt: "", position: { x: 0, y: 0 }, app: { name: "Server", actions: ["start", "kill", "status"] }, command: "sleep 300 & sleep 300 & wait" };
  const execute = async (action: "start" | "kill" | "status", command = block.command!) => {
    const result = await service.execute({ ...block, command }, JSON.stringify({ action }), workspace, () => {}, { rootWorkspace: workspace, workflowRunId: "run", workflowBlockId: "app" });
    return JSON.parse(result.messages[0]!.text) as { pid: number; status: string };
  };
  return { workspace, service, execute, list: () => listProjectApps(workspace, tasks), stop: (id: string) => killProjectApp(workspace, id) };
}
async function eventually(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error("App lifecycle did not settle"); }

describe.skipIf(process.platform !== "linux")("workflow app Proc lifecycle", () => {
  it("counts a process tree once and repeated concurrent starts/stops do not accumulate apps", async () => {
    const { workspace, execute, list, stop } = await setup();
    const baseline = managedProcesses.launchCount;
    let previousId: string | undefined;
    for (let cycle = 0; cycle < 4; cycle++) {
      const starts = await Promise.all([execute("start"), execute("start"), execute("start")]);
      expect(new Set(starts.map((result) => result.pid)).size).toBe(1);
      await eventually(async () => (await list())[0]?.processCount === 3);
      const apps = await list(); expect(apps).toHaveLength(1); expect(apps[0]!.id).not.toBe(previousId); previousId = apps[0]!.id;
      if (cycle % 2) await execute("kill"); else await stop(apps[0]!.id);
      expect(await list()).toEqual([]);
      expect((await managedProcesses.list()).filter((item) => item.workspace === workspace)).toEqual([]);
      expect(await stop(apps[0]!.id)).toBe(false);
      expect((await execute("status")).status).toBe("exited");
    }
    expect(managedProcesses.launchCount).toBeLessThanOrEqual(baseline);
  }, 15_000);
  it("removes natural exits, and a fresh start has a fresh launch identity", async () => {
    const { execute, list } = await setup();
    await execute("start", "sleep 1");
    const first = (await list())[0]!; expect(first).toBeDefined();
    await eventually(async () => (await list()).length === 0);
    expect((await execute("status")).status).toBe("exited");
    await execute("start"); expect((await list())[0]!.id).not.toBe(first.id);
  });
  it("explicit Kill discovers surviving children even when the cached app snapshot is absent", async () => {
    const { workspace, execute } = await setup();
    const marker = path.join(workspace, "uncached-pid");
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
    const command = `${JSON.stringify(process.execPath)} -e '${code.replace(/'/g, "'\\''")}'`;
    const cache = vi.spyOn(managedProcesses, "appSnapshot").mockReturnValue(undefined);
    try {
      await execute("start", command);
      await eventually(async () => (await execute("status")).status === "exited");
      const pid = Number(await readFile(marker, "utf8")); expect(() => process.kill(pid, 0)).not.toThrow();
      await execute("kill");
      expect((await managedProcesses.list()).filter((item) => item.workspace === workspace)).toEqual([]);
    } finally { cache.mockRestore(); }
  });

  it("retains a detached descendant after launcher exit, reuses it on Start, and stops the entire launch", async () => {
    const { workspace, service, execute, list, stop } = await setup();
    const marker = path.join(workspace, "pid");
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
    const command = `${JSON.stringify(process.execPath)} -e '${code.replace(/'/g, "'\\''")}'`;
    const started = await execute("start", command);
    await eventually(async () => (await list())[0]?.status === "descendants-running");
    const [app] = await list(); expect(app).toMatchObject({ name: "Server", launcherPid: started.pid, status: "descendants-running", processCount: 1, workflowRunId: "run" });
    expect(app!.pid).toBe(Number(await readFile(marker, "utf8")));
    expect(service.read("Server", workspace).status).toBe("descendants-running");
    expect(service.hasWorkspace(workspace)).toBe(true);
    const repeated = await execute("start", command); expect(repeated.pid).toBe(started.pid); expect(repeated.status).toBe("descendants-running");
    expect((await list())[0]!.id).toBe(app!.id);
    await stop(app!.id); expect(await list()).toEqual([]); expect(service.hasWorkspace(workspace)).toBe(false);
    // A second launcher exit must also remain stoppable via Run App's Kill action.
    await execute("start", command); await eventually(async () => (await list())[0]?.status === "descendants-running");
    await execute("kill"); expect(await list()).toEqual([]);
  });
});
