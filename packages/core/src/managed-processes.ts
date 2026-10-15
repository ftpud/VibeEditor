import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ManagedProcess, ManagedWorkflowApp } from "@remote-ide/protocol";

const exec = promisify(execFile);
export type ProcessRow = { pid: number; parentPid: number; birth: string; command: string; state: string; launchId?: string };
type Row = ProcessRow;
export type ProcessContext = Pick<ManagedProcess, "workspace" | "rootWorkspace" | "provider" | "sessionId" | "kind" | "workflowRunId" | "workflowBlockId" | "appName"> & { command?: string };
type Context = ProcessContext;
type Launch = { context: Context; pending: boolean; revision: number; launcherPid?: number };
type Entry = { row: Row; context: Context; launchId: string; launchRoot: boolean; ancestors: string[] };

/** Only explicitly registered children and their observed descendants are managed.
 * Start time is part of the identity so a recycled PID cannot authorize a kill.
 * Keep observed descendants after reparenting (background commands outlive turns).
 */
export class ManagedProcesses extends EventEmitter {
  private entries = new Map<number, Entry>();
  private launches = new Map<string, Launch>();
  private revision = 0;
  private roots = new Map<number, { context: Context; launchId: string; birth?: string }>();
  prepare(context: Context): { launchId: string; env: NodeJS.ProcessEnv } {
    const launchId = crypto.randomUUID();
    this.launches.set(launchId, { context, pending: true, revision: ++this.revision });
    return { launchId, env: { ...process.env, VIBE_MANAGED_LAUNCH: launchId } };
  }
  launch<T extends ChildProcess>(context: Context, create: (env: NodeJS.ProcessEnv) => T): T { return this.launchWithIdentity(context, create).child; }
  launchWithIdentity<T extends ChildProcess>(context: Context, create: (env: NodeJS.ProcessEnv) => T): { child: T; launchId: string } {
    const launch = this.prepare(context);
    try { const child = create(launch.env); this.track(child, context, launch.launchId); return { child, launchId: launch.launchId }; }
    catch (error) { this.abandon(launch.launchId); throw error; }
  }
  abandon(launchId: string): void { this.launches.delete(launchId); }
  get launchCount(): number { return this.launches.size; }
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  constructor(private readonly snapshot: () => Promise<Row[]> = processSnapshot,
    private readonly signal: (pid: number) => void = (pid) => process.kill(pid, "SIGKILL")) { super(); }

  track(child: { pid?: number; once(event: "exit" | "error" | "spawn", listener: () => void): unknown }, context: Context, launchId: string): void {
    const register = () => {
      if (!child.pid) return;
      this.roots.set(child.pid, { context, launchId });
      const launch = this.launches.get(launchId); if (launch) { launch.pending = false; launch.launcherPid = child.pid; launch.revision = ++this.revision; }
      void this.refresh().catch(() => {});
    };
    if (child.pid) register(); else child.once("spawn", register);
    const finished = () => {
      if (child.pid && this.roots.get(child.pid)?.launchId === launchId) this.roots.delete(child.pid);
      const launch = this.launches.get(launchId); if (launch) { launch.pending = false; launch.revision = ++this.revision; }
      void this.refresh().catch(() => {});
    };
    child.once("exit", finished); child.once("error", finished);
  }
  setWorkspaceContext(workspace: string, context: Partial<Context>): void {
    for (const launch of this.launches.values()) if (launch.context.workspace === workspace) Object.assign(launch.context, context);
    for (const entry of this.entries.values()) if (entry.context.workspace === workspace) Object.assign(entry.context, context);
    this.emit("changed");
  }
  setSession(pid: number | undefined, sessionId: string): void {
    if (pid === undefined) return;
    const root = this.roots.get(pid); if (root) { root.context.sessionId = sessionId; for (const entry of this.entries.values()) if (entry.launchId === root.launchId) entry.context.sessionId = sessionId; this.emit("changed"); }
  }
  start(): void {
    if (!this.timer) { this.timer = setInterval(() => { if (this.launches.size || this.entries.size || this.roots.size) void this.refresh().catch(() => {}); }, 500); this.timer.unref(); }
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async list(): Promise<ManagedProcess[]> {
    await this.refresh();
    return [...this.entries.values()].map(({ row, context }) => ({ ...context, id: `${row.pid}:${row.birth}`, pid: row.pid,
      parentPid: row.parentPid, command: context.command ?? row.command, status: "running" as const })).sort((a, b) => a.pid - b.pid);
  }
  /** App provenance comes from the launch record, not a descendant's mutable kind. */
  appSnapshot(launchId: string): ManagedWorkflowApp | undefined {
    const launch = this.launches.get(launchId);
    if (!launch || launch.context.kind !== "workflow-app") return undefined;
    const members = [...this.entries.values()].filter((entry) => entry.launchId === launchId);
    const representative = members.find((entry) => entry.launchRoot) ?? members[0];
    if (!representative) return undefined;
    const context = launch.context;
    return { kind: "workflow-app", id: `app:${launchId}`, name: context.appName ?? "Workflow app", pid: representative.row.pid,
      launcherPid: launch.launcherPid, command: context.command ?? representative.row.command,
      status: members.some((entry) => entry.launchRoot) ? "running" : "descendants-running", processCount: members.length,
      workspace: context.workspace, rootWorkspace: context.rootWorkspace, workflowRunId: context.workflowRunId, workflowBlockId: context.workflowBlockId };
  }
  async listApps(): Promise<ManagedWorkflowApp[]> {
    if (!this.launches.size && !this.entries.size && !this.roots.size) return [];
    await this.refresh();
    return [...this.launches.keys()].flatMap((id) => { const app = this.appSnapshot(id); return app ? [app] : []; });
  }
  async kill(id: string, allowed: (context: Context) => Promise<boolean>): Promise<boolean> {
    if (typeof id !== "string") throw new Error("Choose a managed process to kill");
    await this.refresh(true);
    const appLaunchId = id.startsWith("app:") ? id.slice(4) : undefined;
    const appLaunch = appLaunchId ? this.launches.get(appLaunchId) : undefined;
    if (appLaunchId && appLaunch?.context.kind !== "workflow-app") return false;
    const members = [...this.entries.values()];
    const target = appLaunchId
      ? members.find((entry) => entry.launchId === appLaunchId && entry.launchRoot) ?? members.find((entry) => entry.launchId === appLaunchId)
      : members.find(({ row }) => `${row.pid}:${row.birth}` === id);
    if (!target) {
      if (appLaunchId && [...this.roots.values()].some((root) => root.launchId === appLaunchId)) throw new Error("Could not verify the app launcher identity. Refresh and retry Stop; check Core /proc permissions.");
      return false;
    } // Natural exit, including PID reuse.
    const selected = new Map(this.entries);
    if (!await allowed(appLaunch?.context ?? target.context)) throw new Error("Process belongs to another project");
    const targetId = `${target.row.pid}:${target.row.birth}`;
    const wholeLaunch = !!appLaunchId || target.launchRoot;
    const descendants = new Set([target.row.pid]);
    for (const entry of selected.values()) if (entry.ancestors.includes(targetId) || (wholeLaunch && entry.launchId === target.launchId)) descendants.add(entry.row.pid);
    let changed = true;
    while (changed) { changed = false; for (const { row } of selected.values()) if (descendants.has(row.parentPid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
    // Each pass reconciles the cache from its discovery snapshot before signalling.
    // A no-candidates return therefore cannot leave a stale appSnapshot behind.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await this.refresh(true);
      for (const entry of this.entries.values()) {
        if (entry.ancestors.includes(targetId) || (wholeLaunch && entry.launchId === target.launchId)) {
          selected.set(entry.row.pid, entry); descendants.add(entry.row.pid);
        }
      }
      const candidates = [...this.entries.values()].filter((entry) =>
        descendants.has(entry.row.pid) && selected.get(entry.row.pid)?.row.birth === entry.row.birth);
      if (!candidates.length) return true;
      candidates.sort((a, b) => Number(b.row.pid === target.row.pid) - Number(a.row.pid === target.row.pid));
      for (const { row } of candidates) {
        try {
          // Verify at the signal boundary without another expensive whole-host scan.
          if (this.snapshot === processSnapshot && process.platform === "linux") {
            const stat = await readFile(`/proc/${row.pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (fields[19] !== row.birth || fields[0] === "Z") continue;
          }
          this.signal(row.pid);
        } catch (error) {
          if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error(`Could not kill PID ${row.pid}: ${error instanceof Error ? error.message : String(error)}. Check Core host permissions.`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.refresh(true);
    if ([...this.entries.values()].some(({ row }) => descendants.has(row.pid) && selected.get(row.pid)?.row.birth === row.birth)) {
      throw new Error(`PID ${target.row.pid} or its descendants are still exiting. Refresh processes and retry Kill.`);
    }
    return true;
  }
  private refresh(fresh = false): Promise<void> {
    if (this.refreshing) return fresh ? this.refreshing.then(() => this.refresh()) : this.refreshing;
    this.refreshing = this.update().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async update(): Promise<void> {
    // Only prune launches unchanged throughout a complete snapshot. A parent may
    // exit mid-scan after starting a child absent from that scan’s initial PID list.
    const revisions = new Map([...this.launches].map(([id, launch]) => [id, launch.revision]));
    const rows = await this.snapshot();
    const visible = (entries: Map<number, Entry>) => JSON.stringify([...entries.values()].map(({ row, context }) => [row.pid, row.birth, row.command, context]));
    const previous = visible(this.entries);
    const next = new Map<number, Entry>();
    for (const row of rows) {
      if (row.state.startsWith("Z")) continue;
      const old = this.entries.get(row.pid);
      const root = this.roots.get(row.pid);
      // A registered PID is accepted once, then always checked against its birth identity.
      if (root && !root.birth && (process.platform !== "linux" || row.launchId === root.launchId)) root.birth = row.birth;
      const registered = root?.birth === row.birth ? root.context : undefined;
      const inherited = row.launchId ? this.launches.get(row.launchId)?.context : undefined;
      const context = old?.row.birth === row.birth ? old.context : registered ?? (inherited ? { ...inherited, command: undefined, kind: "command" as const } : undefined);
      if (context) next.set(row.pid, { row, context, launchId: old?.row.birth === row.birth ? old.launchId : registered ? root!.launchId : row.launchId!, launchRoot: !!registered || (old?.row.birth === row.birth && old.launchRoot), ancestors: old?.row.birth === row.birth ? old.ancestors : [] });
    }
    let changed = true;
    while (changed) { changed = false; for (const row of rows) {
      const parent = next.get(row.parentPid);
      if (!next.has(row.pid) && parent && !row.state.startsWith("Z")) {
        next.set(row.pid, { row, context: { ...parent.context, command: undefined, kind: "command" }, launchId: parent.launchId, launchRoot: false, ancestors: [...parent.ancestors, `${parent.row.pid}:${parent.row.birth}`] }); changed = true;
      }
    } }
    for (const entry of next.values()) {
      const seen = new Set<number>([entry.row.pid]); let parent = next.get(entry.row.parentPid);
      while (parent && !seen.has(parent.row.pid)) { seen.add(parent.row.pid); const id = `${parent.row.pid}:${parent.row.birth}`; if (!entry.ancestors.includes(id)) entry.ancestors.push(id); parent = next.get(parent.row.parentPid); }
    }
    const activeLaunches = new Set([...next.values()].map((entry) => entry.launchId));
    for (const root of this.roots.values()) activeLaunches.add(root.launchId);
    for (const [id, launch] of this.launches) {
      if (!launch.pending && revisions.get(id) === launch.revision && !activeLaunches.has(id)) this.launches.delete(id);
    }
    this.entries = next;
    if (visible(next) !== previous) this.emit("changed");
  }
}
async function processSnapshot(): Promise<Row[]> {
  if (process.platform === "linux") {
    const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const rows: Row[] = [];
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = await Promise.all(names.slice(offset, offset + 32).map(async (name): Promise<Row | undefined> => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, "utf8");
          const end = stat.lastIndexOf(")"); const fields = stat.slice(end + 2).split(" ");
          if (!fields[19] || !fields[0]) return undefined;
          const [command, environment] = await Promise.all([readFile(`/proc/${name}/cmdline`, "utf8").catch(() => ""), readFile(`/proc/${name}/environ`, "utf8").catch(() => "")]);
          const launchId = environment.split("\0").find((item) => item.startsWith("VIBE_MANAGED_LAUNCH="))?.slice("VIBE_MANAGED_LAUNCH=".length);
          const verify = await readFile(`/proc/${name}/stat`, "utf8");
          if (verify.slice(verify.lastIndexOf(")") + 2).split(" ")[19] !== fields[19]) return undefined;
          return { pid: Number(name), parentPid: Number(fields[1]), birth: fields[19], state: fields[0], command: command.replace(/\0/g, " ").trim() || stat.slice(stat.indexOf("(") + 1, end), launchId };
        } catch { return undefined; }
      }));
      for (const row of batch) if (row) rows.push(row);
    }
    return rows;
  }
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,lstart=,stat=,command="], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), birth: match[3]!, state: match[4]!, command: match[5]! }] : [];
  });
}
export const managedProcesses = new ManagedProcesses();
