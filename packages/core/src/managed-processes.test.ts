import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedProcesses, type ProcessRow } from "./managed-processes.js";

const context = { workspace: "/project/tasks/a", rootWorkspace: "/project", provider: "neutral", sessionId: "session-a", kind: "agent" as const };
const hosts: ManagedProcesses[] = [];
const children: ChildProcess[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.close(); for (const child of children.splice(0)) child.kill("SIGKILL"); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(25); } throw new Error("Process condition did not settle"); }

function fakeHost() {
  let rows: ProcessRow[] = [];
  const signal = vi.fn((pid: number) => { rows = rows.filter((row) => row.pid !== pid); });
  const host = new ManagedProcesses(async () => rows, signal); hosts.push(host);
  const launch = host.prepare(context);
  const row = (pid: number, parentPid = 1, birth = `ticks-${pid}`): ProcessRow => ({ pid, parentPid, birth, command: `cmd-${pid}`, state: "S", launchId: launch.launchId });
  const child = Object.assign(new EventEmitter(), { pid: 10 }) as ChildProcess;
  return { host, launch, signal, row, child, setRows: (value: ProcessRow[]) => { rows = value; } };
}
describe("managed process ownership", () => {
  it("retains observed ancestry after reparenting and never signals another session or host process", async () => {
    const { host, launch, signal, row, child, setRows } = fakeHost();
    setRows([row(10), row(11, 10), row(12, 11), { ...row(99), launchId: undefined }]);
    host.track(child, context, launch.launchId);
    const list = await host.list(); expect(list.map((item) => item.pid)).toEqual([10, 11, 12]);
    const target = list.find((item) => item.pid === 11)!;
    setRows([row(10), row(11, 10), row(12, 1), { ...row(99), launchId: undefined }]);
    expect(await host.kill(target.id, async () => true)).toBe(true);
    expect(signal.mock.calls.map(([pid]) => pid).sort()).toEqual([11, 12]);
    expect((await host.list()).map((item) => item.pid)).toEqual([10]);
  });
  it("guards both registered roots and stale kill IDs against PID reuse", async () => {
    const { host, launch, signal, row, child, setRows } = fakeHost();
    setRows([row(10)]); host.track(child, context, launch.launchId);
    const old = (await host.list())[0]!;
    setRows([{ ...row(10, 1, "new-ticks"), launchId: undefined }]);
    expect(await host.list()).toEqual([]);
    expect(await host.kill(old.id, async () => true)).toBe(false); expect(signal).not.toHaveBeenCalled();
  });
  it("treats an already exited process as a successful no-op and rejects cross-project kills", async () => {
    const { host, launch, signal, row, child, setRows } = fakeHost();
    setRows([row(10)]); host.track(child, context, launch.launchId);
    const old = (await host.list())[0]!;
    await expect(host.kill(old.id, async () => false)).rejects.toThrow("another project"); expect(signal).not.toHaveBeenCalled();
    setRows([]); child.emit("exit", 0); expect(await host.kill(old.id, async () => true)).toBe(false);
  });
  it("prunes completed launches only after a complete snapshot, including failed launches", async () => {
    const { host, launch, row, child, setRows } = fakeHost();
    setRows([row(10)]); host.track(child, context, launch.launchId); await host.list();
    expect(host.launchCount).toBe(1);
    setRows([]); child.emit("exit", 0); await host.list(); await host.list();
    expect(host.launchCount).toBe(0);
    expect(() => host.launch(context, () => { throw new Error("sync spawn failure"); })).toThrow("sync spawn failure");
    expect(host.launchCount).toBe(0);
    const failed = new EventEmitter() as ChildProcess;
    host.launch(context, () => failed); failed.emit("error", new Error("ENOENT"));
    await host.list(); await host.list(); expect(host.launchCount).toBe(0);
  });
  it("does not prune an orphan launch when the parent exits during a snapshot", async () => {
    let rows: ProcessRow[] = []; let release: ((rows: ProcessRow[]) => void) | undefined; let hold = false;
    const host = new ManagedProcesses(async () => hold ? new Promise<ProcessRow[]>((resolve) => { release = resolve; }) : rows); hosts.push(host);
    const launch = host.prepare(context); const child = Object.assign(new EventEmitter(), { pid: 10 }) as ChildProcess;
    const row = (pid: number): ProcessRow => ({ pid, parentPid: 1, birth: `tick-${pid}`, command: "node", state: "S", launchId: launch.launchId });
    rows = [row(10)]; host.track(child, context, launch.launchId); await host.list();
    hold = true; const scan = host.list(); child.emit("exit", 0); release!([]); await scan;
    expect(host.launchCount).toBe(1);
    hold = false; rows = [row(11)]; expect((await host.list()).map((item) => item.pid)).toEqual([11]);
    rows = []; await host.list(); expect(host.launchCount).toBe(0);
  });
  it("does not scan the host periodically when idle", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = vi.fn(async () => []); const host = new ManagedProcesses(snapshot); hosts.push(host); host.start();
      await vi.advanceTimersByTimeAsync(1500); expect(snapshot).not.toHaveBeenCalled();
      host.close();
    } finally { vi.useRealTimers(); }
  });
  it("reconciles an app whose last process exits between the cached and kill snapshots", async () => {
    let launchId: string; let snapshots = 0;
    const snapshot = async (): Promise<ProcessRow[]> => {
      snapshots++;
      return snapshots < 2 ? [{ pid: 50, parentPid: 1, birth: "ticks-50", command: "app child", state: "S", launchId }] : [];
    };
    const signal = vi.fn(); const host = new ManagedProcesses(snapshot, signal); hosts.push(host);
    launchId = host.prepare({ ...context, kind: "workflow-app", appName: "Server" }).launchId;
    expect(await host.listApps()).toHaveLength(1);
    expect(await host.kill(`app:${launchId}`, async () => true)).toBe(false);
    expect(signal).not.toHaveBeenCalled();
    expect(host.appSnapshot(launchId)).toBeUndefined();
    expect(await host.listApps()).toEqual([]);
  });
  it("reports permission errors with the selected PID", async () => {
    let launchId: string;
    const host = new ManagedProcesses(async (): Promise<ProcessRow[]> => [{ pid: 10, parentPid: 1, birth: "10", command: "app", state: "S", launchId }], () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    hosts.push(host); launchId = host.prepare(context).launchId;
    const [entry] = await host.list(); await expect(host.kill(entry!.id, async () => true)).rejects.toThrow("Could not kill PID 10");
  });
});

describe.skipIf(process.platform !== "linux")("real Linux subprocess lifecycle", () => {
  it("finds orphaned background commands from a short-lived parent and kills them with their agent, isolating another task", async () => {
    const host = new ManagedProcesses(); hosts.push(host);
    const directory = await mkdtemp(path.join(os.tmpdir(), "vibe-process-test-"));
    let orphanPid: number | undefined;
    try {
      const marker = path.join(directory, "pid");
      const intermediate = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
      const script = `const {spawn}=require('node:child_process');setTimeout(()=>{spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore'});},100);setInterval(()=>{},1000);`;
      const launch = host.prepare(context);
      const root = spawn(process.execPath, ["-e", script], { env: launch.env, stdio: "ignore" }); children.push(root); host.track(root, context, launch.launchId);
      const otherContext = { ...context, workspace: "/project/tasks/b", sessionId: "session-b" };
      const otherLaunch = host.prepare(otherContext);
      const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: otherLaunch.env, stdio: "ignore" }); children.push(other); host.track(other, otherContext, otherLaunch.launchId);
      const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); children.push(unrelated);
      await eventually(async () => { try { orphanPid = Number(await readFile(marker, "utf8")); return !!orphanPid; } catch { return false; } });
      await delay(150); // Intermediate parent has exited before the next discovery.
      const list = await host.list();
      expect(list.some((item) => item.pid === orphanPid && item.sessionId === "session-a")).toBe(true);
      expect(list.some((item) => item.pid === other.pid && item.workspace === otherContext.workspace)).toBe(true);
      expect(list.some((item) => item.pid === unrelated.pid)).toBe(false);
      const agent = list.find((item) => item.pid === root.pid)!; expect(agent.kind).toBe("agent");
      await host.kill(agent.id, async () => true);
      await eventually(async () => !(await host.list()).some((item) => item.pid === orphanPid || item.pid === root.pid));
      expect((await host.list()).some((item) => item.pid === other.pid)).toBe(true);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      expect(await host.kill(agent.id, async () => true)).toBe(false);
    } finally { if (orphanPid) { try { process.kill(orphanPid, "SIGKILL"); } catch {} } await rm(directory, { recursive: true, force: true }); }
  });
  it("publishes natural exits and preserves workflow app metadata", async () => {
    const host = new ManagedProcesses(); hosts.push(host); host.start(); const changed = vi.fn(); host.on("changed", changed);
    const appContext = { ...context, provider: undefined, kind: "workflow-app" as const, workflowRunId: "run", workflowBlockId: "app" };
    const launch = host.prepare(appContext); const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},500)"], { env: launch.env, stdio: "ignore" }); children.push(child); host.track(child, appContext, launch.launchId);
    await eventually(async () => (await host.list()).some((item) => item.workflowRunId === "run" && item.pid === child.pid));
    await eventually(async () => !(await host.list()).some((item) => item.pid === child.pid));
    expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
