import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, readdir, rm, statfs } from "node:fs/promises";
import type { StorageAge, StorageCategory, StorageCleanup, StorageSnapshot, StorageUsage } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { HarnessStore } from "./harnesses.js";
import { StorageVersions, type VersionOptions } from "./storage-versions.js";
import { storageProcessSnapshot } from "./storage-processes.js";

const exec = promisify(execFile);
const keyFor = (workspace: string) => crypto.createHash("sha256").update(workspace).digest("hex");
const terminalRun = new Set(["succeeded", "failed", "cancelled", "blocked"]);
const definitions: [StorageCategory, string, string][] = [
  ["tasks", "Task workspaces", "Keep root & active removes finished tasks and leftover task/integration folders. Root, active, selected and busy workspaces stay. Branches are preserved; discarding uncommitted changes requires acknowledgement."],
  ["sessions", "AI conversations & sessions", "Archived conversations can be removed by age. Current conversations and session indexes are retained."],
  ["workflows", "Workflow execution history", "Removes ended runs by completion date and old temporary files. Age shares and reclaimable sizes are estimates; totals measure disk usage. Definitions and active runs are retained."],
  ["checkpoints", "Checkpoints & file snapshots", "Complete snapshot stores for inactive finished tasks can be removed by age. Active and unidentified stores are retained."],
  ["logs", "Server & tool logs", "Old rotated server logs can be removed. Current logs and command bridge state are retained."],
  ["provider", "Provider data", "Native session logs, databases, settings and credentials. Retained: provider databases and their linked histories must be managed together."],
  ["runtime", "Runtimes & deployments", "Keep current version removes obsolete agent runtimes, Core/Desktop releases and rebuildable source caches. It first closes other Vibe sessions for this SSH account. This connection and the current versions stay."],
  ["other", "Settings & other state", "Workspace settings, schedules, definitions and unrecognized state are retained."],
];
export function storageCutoffs(now: number): { today: number; week: number } {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  return { today: day.getTime(), week: now - 7 * 24 * 60 * 60 * 1000 };
}
export function storageAge(stamp: number, now: number): StorageAge {
  const cutoffs = storageCutoffs(now);
  return stamp >= cutoffs.today ? "today" : stamp >= cutoffs.week ? "week" : "older";
}
type Candidate = { category: StorageCategory; stamp: number; bytes: number; label?: string; group?: string; mode?: "inactive" | "versions"; remove: (cutoff: number) => Promise<void> };
type StorageOptions = { home?: string; stateDirectory?: string; roots: () => string[]; isBusy: (workspace: string) => Promise<boolean>; changed?: () => void; versions?: Omit<VersionOptions, "home" | "runtimeDirectory"> };

/** One bounded job per Core server. Paths and deletion candidates never come from the client. */
export class ServerStorage {
  private readonly home: string;
  private readonly stateDirectory: string;
  private readonly providerDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly versions: StorageVersions;
  private candidates: Candidate[] = [];
  private job?: Promise<void>;
  private readonly warnings = new Set<string>();
  private snapshot: StorageSnapshot;
  constructor(private readonly options: StorageOptions) {
    this.home = options.home ?? os.homedir();
    this.stateDirectory = path.resolve(options.stateDirectory ?? process.env.REMOTE_IDE_STATE_DIR ?? path.join(this.home, ".remote-ide", "workspaces"));
    this.providerDirectory = path.resolve((!options.home && process.env.CODEX_HOME) || path.join(this.home, ".codex"));
    this.runtimeDirectory = path.resolve((!options.home && process.env.REMOTE_IDE_CODEX_RUNTIME_DIR) || path.join(this.home, ".remote-ide", "codex-runtime"));
    this.versions = new StorageVersions({ home: this.home, runtimeDirectory: this.runtimeDirectory, ...options.versions });
    this.snapshot = { id: "", phase: "idle", updatedAt: new Date().toISOString(), server: os.hostname(), paths: [this.stateDirectory, this.providerDirectory, this.runtimeDirectory, path.join(this.home, ".vibe-deploy"), path.join(this.home, ".vibe-server-*.log*")], categories: [], totalBytes: 0, scannedFiles: 0, message: "Open storage to calculate usage", warnings: [] };
  }
  status(): StorageSnapshot {
    const snapshot = structuredClone(this.snapshot);
    const order = ["current", "active", "finished", "unregistered", "obsolete", "today", "week", "older", "retained"];
    for (const row of snapshot.categories) row.segments.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
    return snapshot;
  }
  async drain(): Promise<void> { await this.job; }
  scan(): StorageSnapshot {
    if (!this.job) this.launch(() => this.calculate());
    return this.status();
  }
  cleanup(request: StorageCleanup): StorageSnapshot {
    if (this.job || this.snapshot.phase !== "ready" || request.scanId !== this.snapshot.id) throw new CoreError("INVALID_REQUEST", "Refresh storage and wait for the current scan to finish");
    if (!definitions.some(([id]) => id === request.category) || !["finished", "week", "older", "inactive", "versions"].includes(request.age) || (request.category === "tasks") !== ["finished", "inactive"].includes(request.age) || (request.category === "runtime") !== (request.age === "versions")) throw new CoreError("INVALID_REQUEST", "Invalid storage cleanup selection");
    if (request.age === "inactive" && request.discardChanges !== true) throw new CoreError("INVALID_REQUEST", "Acknowledge discarding inactive workspace changes before removing them");
    if (request.age === "versions" && request.closeOtherSessions !== true) throw new CoreError("INVALID_REQUEST", "Confirm closing other Vibe sessions before removing versions");
    const cutoff = request.age === "older" ? storageCutoffs(Date.now()).week : storageCutoffs(Date.now()).today;
    const candidates = this.candidates.filter((item) => item.category === request.category && (item.mode ? item.mode === request.age : !["inactive", "versions"].includes(request.age) && (request.age === "finished" || item.stamp < cutoff)));
    if (!candidates.length) throw new CoreError("INVALID_REQUEST", "There is no eligible data in this selection");
    this.snapshot.phase = "cleaning";
    this.snapshot.message = `Cleaning ${candidates.length} stored items…`;
    this.launch(async () => {
      let removed = 0; let skipped = 0;
      const groups = new Set<string>();
      for (const item of candidates) {
        if (item.group && groups.has(item.group)) continue;
        if (item.group) groups.add(item.group);
        try { await item.remove(cutoff); removed += 1; }
        catch (error) { skipped += 1; this.warn(`Skipped ${item.label ?? item.category}: ${this.message(error)}`); }
        this.snapshot.message = `Cleanup: ${removed} groups removed, ${skipped} skipped`;
        this.snapshot.updatedAt = new Date().toISOString();
      }
      const warnings = [...this.warnings];
      await this.calculate();
      this.options.changed?.();
      for (const warning of warnings) this.warn(warning);
      this.snapshot.message = `Cleanup complete: ${removed} storage groups cleaned${skipped ? `, ${skipped} skipped` : ""}. Usage recalculated.`;
    });
    return this.status();
  }
  private launch(operation: () => Promise<void>): void {
    this.job = operation().catch((error) => { this.snapshot.phase = "error"; this.snapshot.message = this.message(error); }).finally(() => { this.job = undefined; });
  }
  private message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "Storage operation failed"; }
  private warn(message: string): void { if (this.warnings.size < 30) this.warnings.add(message); this.snapshot.warnings = [...this.warnings]; }
  private async names(directory: string): Promise<string[]> {
    try { return await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`Could not read ${directory}: ${this.message(error)}`); return []; }
  }
  private usage(id: StorageCategory): StorageUsage { return this.snapshot.categories.find((item) => item.id === id)!; }
  private add(id: StorageCategory, bytes: number, segment: string, count = 1): void {
    const row = this.usage(id); row.bytes += bytes; row.count += count;
    let part = row.segments.find((item) => item.id === segment);
    if (!part) { part = { id: segment, label: { current: "Current", obsolete: "Obsolete", unregistered: "Unregistered", active: "Active", finished: "Finished", retained: "Retained", today: "Today", week: "Previous 7 days", older: "Older" }[segment] ?? segment, bytes: 0 }; row.segments.push(part); }
    part.bytes += bytes; this.snapshot.totalBytes += bytes; this.snapshot.scannedFiles += count;
    this.snapshot.updatedAt = new Date().toISOString();
  }
  private candidate(candidate: Candidate): void {
    this.candidates.push(candidate); const row = this.usage(candidate.category);
    if (candidate.mode) row.cleanable[candidate.mode] = (row.cleanable[candidate.mode] ?? 0) + candidate.bytes;
    else if (candidate.category === "tasks") row.cleanable.finished += candidate.bytes;
    else {
      const cutoffs = storageCutoffs(Date.now());
      if (candidate.stamp < cutoffs.today) row.cleanable.week += candidate.bytes;
      if (candidate.stamp < cutoffs.week) row.cleanable.older += candidate.bytes;
    }
  }
  /** du counts allocated blocks, hardlinks once per unit, and never follows symlink targets. */
  private async size(file: string): Promise<number> {
    try {
      await this.assertSafe(file);
      const result = await exec("du", ["-sk", file], { maxBuffer: 1024 * 1024 });
      const bytes = Number(result.stdout.trim().split(/\s/)[0]) * 1024;
      if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Invalid disk usage result");
      return bytes;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(`Could not measure ${file}: ${this.message(error)}`); return 0; }
  }
  private async assertSafe(file: string): Promise<void> {
    const allowed = [this.stateDirectory, this.providerDirectory, this.runtimeDirectory, path.join(this.home, ".vibe-deploy")];
    const absolute = path.resolve(file);
    const root = allowed.find((base) => absolute === path.resolve(base) || absolute.startsWith(`${path.resolve(base)}${path.sep}`));
    if (!root && !(path.dirname(absolute) === this.home && /^\.vibe-server-[\w-]+\.log(?:\.previous)?$/.test(path.basename(absolute)))) throw new Error("Path is outside managed storage");
    // Reject substituted ancestors as well as symlink leaves. No directory traversal through aliases.
    let cursor = absolute;
    while (cursor !== path.dirname(cursor)) { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are retained"); cursor = path.dirname(cursor); }
  }
  private async retain(file: string, category: StorageCategory, segment?: string): Promise<void> {
    const meta = await lstat(file).catch(() => undefined); if (!meta || meta.isSymbolicLink()) return;
    const bytes = await this.size(file); this.add(category, bytes, segment ?? storageAge(meta.mtimeMs, Date.now()));
  }
  private async removableFile(file: string, category: StorageCategory, eligible = true, guard?: () => Promise<void>): Promise<void> {
    const meta = await lstat(file).catch(() => undefined); if (!meta?.isFile()) return;
    const bytes = meta.blocks * 512; this.add(category, bytes, storageAge(meta.mtimeMs, Date.now()));
    if (eligible) this.candidate({ category, bytes, label: path.basename(file), stamp: meta.mtimeMs, remove: async (cutoff) => {
      await guard?.();
      await this.assertSafe(file); const current = await lstat(file);
      if (!current.isFile() || current.ino !== meta.ino || current.dev !== meta.dev || current.size !== meta.size || current.mtimeMs !== meta.mtimeMs || current.mtimeMs >= cutoff) throw new Error("File changed since the scan");
      await rm(file);
    } });
  }
  private async newest(directory: string): Promise<number> {
    await this.assertSafe(directory);
    let newest = (await lstat(directory)).mtimeMs;
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name); const meta = await lstat(file);
      if (meta.isSymbolicLink()) throw new Error("Snapshot contains a symbolic link");
      newest = Math.max(newest, meta.isDirectory() ? await this.newest(file) : meta.mtimeMs);
    }
    return newest;
  }
  private async activeReferences(): Promise<{ workspaces: Set<string>; sessions: Set<string> }> {
    const workspaces = new Set<string>(); const sessions = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === "workspace" && typeof entry === "string") workspaces.add(entry);
        else if (key === "sessionId" && typeof entry === "string") sessions.add(entry);
        else if (typeof entry === "object") visit(entry);
      }
    };
    const directory = path.join(this.stateDirectory, "harnesses");
    for (const key of await this.names(directory)) {
      const file = path.join(directory, key, "runs.json");
      try { await this.assertSafe(file); const value = JSON.parse(await readFile(file, "utf8")); for (const run of value.runs ?? []) if (!terminalRun.has(run.status)) visit(run); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Workflow activity could not be verified; cleanup skipped"); }
    }
    return { workspaces, sessions };
  }
  private async isBusy(workspace: string): Promise<boolean> {
    if (await this.options.isBusy(workspace) || (await this.activeReferences()).workspaces.has(workspace)) return true;
    // Include terminals/apps owned by other Core instances, beyond this process's managed registry.
    if (process.platform === "linux") {
      const pids = (await readdir("/proc")).filter((pid) => /^\d+$/.test(pid));
      for (let index = 0; index < pids.length; index += 64) {
        const paths = await Promise.all(pids.slice(index, index + 64).map(async (pid) => {
          try { return await readlink(`/proc/${pid}/cwd`); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EACCES" && (await lstat(`/proc/${pid}`).catch(() => undefined))?.uid === process.getuid?.()) this.warn("Some process working directories are unreadable; known terminal, agent and workflow activity is still protected.");
            return "";
          }
        }));
        if (paths.some((cwd) => cwd === workspace || cwd.startsWith(`${workspace}${path.sep}`))) return true;
      }
    }
    const prefix = `${keyFor(workspace)}-`;
    for (const name of await this.names(this.stateDirectory)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json") || name.includes("sessions")) continue;
      const file = path.join(this.stateDirectory, name); await this.assertSafe(file);
      const value = JSON.parse(await readFile(file, "utf8"));
      if (["in_progress", "user_prompt"].includes(value.status) || value.pendingPermission || value.pendingQuestion) return true;
    }
    return false;
  }
  private async rootPaths(): Promise<string[]> {
    const roots = new Set(this.options.roots().map((root) => path.resolve(root)));
    if (process.platform === "linux") for (const row of await storageProcessSnapshot()) {
      if (!row.core) continue;
      const index = row.argv.indexOf("--workspace"); const workspace = row.argv[index + 1];
      if (index >= 0 && workspace && path.isAbsolute(workspace)) roots.add(path.resolve(workspace));
    }
    for (const directory of [this.stateDirectory, path.join(this.home, ".remote-ide", "workspace-groups")]) {
      for (const name of (await this.names(directory)).filter((name) => /^roots-[a-f0-9]+\.json$/.test(name))) {
        const value = JSON.parse(await readFile(path.join(directory, name), "utf8"));
        if (!Array.isArray(value.roots)) throw new Error("Cannot verify workspace root registry");
        for (const root of value.roots) if (typeof root.path === "string" && path.isAbsolute(root.path)) roots.add(path.resolve(root.path));
      }
    }
    return [...roots];
  }
  private async protectRoots(container: string): Promise<void> {
    if ((await this.rootPaths()).some((root) => root === container || root.startsWith(`${container}${path.sep}`))) throw new Error("Workspace contains a registered project root");
  }
  private async calculate(): Promise<void> {
    this.candidates = []; this.warnings.clear();
    this.snapshot = { ...this.snapshot, id: crypto.randomUUID(), phase: "scanning", totalBytes: 0, scannedFiles: 0, warnings: [], updatedAt: new Date().toISOString(), message: "Measuring server storage…", categories: definitions.map(([id, label, description]) => ({ id, label, description, bytes: 0, count: 0, segments: [], cleanable: { finished: 0, week: 0, older: 0 } })) };
    const disk = await statfs(this.stateDirectory).catch(() => undefined);
    this.snapshot.disk = disk ? { total: disk.blocks * disk.bsize, available: disk.bavail * disk.bsize } : undefined;
    const names = await this.names(this.stateDirectory);
    const roots = new Map((await this.rootPaths()).map((root) => [keyFor(root), root]));
    const finished = new Map<string, { workspace: string; root: string }>();
    const currentSessionIds = new Set<string>();
    const currentSessionFiles = new Set<string>();
    // Archive copies of the current conversation must remain available for live sessions.
    for (const name of names.filter((name) => /^[a-f0-9]{64}-.+\.json$/.test(name) && !name.includes("sessions"))) {
      try { const file = path.join(this.stateDirectory, name); await this.assertSafe(file); const value = JSON.parse(await readFile(file, "utf8")); if (typeof value.id === "string" && Array.isArray(value.messages)) { currentSessionIds.add(value.id); currentSessionFiles.add(name); } } catch { /* Not a conversation. */ }
    }
    for (const name of names.filter((name) => /^[a-f0-9]{64}-tasks$/.test(name))) {
      const directory = path.join(this.stateDirectory, name); await this.assertSafe(directory);
      try {
        const registry = JSON.parse(await readFile(path.join(directory, "tasks.json"), "utf8"));
        if (!Array.isArray(registry.tasks)) throw new Error("Invalid task registry");
        let root = roots.get(name.slice(0, 64));
        if (!root) {
          // Existing worktrees carry the original root identity; verify its hash before trusting it.
          const possibleTasks = [...registry.tasks, ...(await this.names(directory)).filter((name) => /^[\w-]+$/.test(name)).map((id) => ({ id }))];
          for (const task of possibleTasks) {
            if (typeof task.id !== "string" || !/^[\w-]+$/.test(task.id)) continue;
            const workspace = path.join(directory, task.id, "workspace");
            const common = await exec("git", ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => undefined);
            const inferred = common ? path.dirname(common.stdout.trim()) : undefined;
            if (inferred && keyFor(inferred) === name.slice(0, 64)) { root = inferred; roots.set(keyFor(root), root); break; }
          }
        }
        const known = new Set<string>(["tasks.json"]);
        for (const task of registry.tasks) {
          if (typeof task.id !== "string" || !/^[\w-]+$/.test(task.id)) { this.warn(`Invalid task identity in ${name}`); continue; }
          known.add(task.id); const container = path.join(directory, task.id); const workspace = path.join(container, "workspace");
          const bytes = await this.size(container); const isFinished = task.status === "finished";
          const isRoot = [...roots.values()].some((registered) => registered === container || registered.startsWith(`${container}${path.sep}`));
          this.add("tasks", bytes, isRoot ? "retained" : isFinished ? "finished" : "active");
          (this.usage("tasks").entries ??= []).push({ path: workspace, label: String(task.name ?? task.id), bytes, state: isRoot ? "Root workspace" : isFinished ? "Finished" : "Active" });
          if (root && isFinished && !isRoot) {
            finished.set(keyFor(workspace), { root, workspace });
            if (registry.selectedTaskId !== task.id) {
              const store = new WorkspaceTaskStore(root, this.stateDirectory);
              this.candidate({ category: "tasks", bytes, label: String(task.name ?? task.id).slice(0, 200), stamp: 0, remove: async () => { await this.assertSafe(workspace); await this.protectRoots(container); await store.cleanupFinished(task.id, (target) => this.isBusy(target)); } });
              this.candidate({ category: "tasks", mode: "inactive", bytes, label: String(task.name ?? task.id), stamp: 0, remove: async () => { await this.assertSafe(workspace); await this.protectRoots(container); await this.protectRoots(path.join(this.stateDirectory, `${keyFor(workspace)}-task-history`)); await store.cleanupFinished(task.id, (target) => this.isBusy(target), true); } });
            }
          }
        }
        for (const entry of await this.names(directory)) if (!known.has(entry)) {
          const children = entry === "integrations" ? await this.names(path.join(directory, entry)) : [entry];
          for (const id of children) {
            const integration = entry === "integrations"; const container = path.join(directory, ...(integration ? ["integrations", id] : [id]));
            const meta = await lstat(container).catch(() => undefined);
            if (!meta?.isDirectory() || meta.isSymbolicLink() || !/^[\w-]+$/.test(id)) { await this.retain(container, "tasks", "retained"); continue; }
            const bytes = await this.size(container); const workspace = path.join(container, "workspace");
            const active = integration && registry.integrations?.some((record: { id: string; status: string }) => record.id === id && ["preparing", "testing", "applying"].includes(record.status));
            const isRoot = [...roots.values()].some((registered) => registered === container || registered.startsWith(`${container}${path.sep}`));
            this.add("tasks", bytes, isRoot ? "retained" : active ? "active" : "unregistered");
            (this.usage("tasks").entries ??= []).push({ path: workspace, label: integration ? `Integration ${id}` : `Leftover task ${id}`, bytes, state: isRoot ? "Root workspace" : active ? "Active" : "Unregistered" });
            if (root && !active && !isRoot) {
              const store = new WorkspaceTaskStore(root, this.stateDirectory);
              this.candidate({ category: "tasks", mode: "inactive", bytes, label: id, stamp: 0, remove: async () => { await this.assertSafe(container); await this.protectRoots(container); await this.protectRoots(path.join(this.stateDirectory, `${keyFor(workspace)}-task-history`)); await store.cleanupUnregistered(id, integration, (target) => this.isBusy(target)); } });
            }
          }
        }
        await this.retain(path.join(directory, "tasks.json"), "other", "retained");
      } catch (error) { this.warn(`Task storage ${name}: ${this.message(error)}`); }
    }
    for (const name of names) {
      const file = path.join(this.stateDirectory, name);
      if (/^[a-f0-9]{64}-tasks$/.test(name)) continue;
      if (/^[a-f0-9]{64}-.+-sessions$/.test(name)) {
        await this.assertSafe(file);
        for (const entry of await this.names(file)) {
          const sessionId = entry.slice(0, -5);
          await this.removableFile(path.join(file, entry), "sessions", entry.endsWith(".json") && !currentSessionIds.has(sessionId), async () => {
            if ((await this.activeReferences()).sessions.has(sessionId)) throw new Error("Conversation belongs to an active workflow");
          });
        }
      } else if (name.endsWith("-task-history")) {
        const owner = finished.get(name.slice(0, 64)); const bytes = await this.size(file);
        const stamp = owner ? await this.newest(file).catch(() => Date.now()) : Date.now();
        this.add("checkpoints", bytes, owner ? storageAge(stamp, Date.now()) : "retained");
        if (owner) this.candidate({ category: "checkpoints", bytes, stamp, remove: async (cutoff) => {
          if (await this.isBusy(owner.workspace) || await this.newest(file) >= cutoff) throw new Error("Snapshot store is active or has recent files");
          const registry = await new WorkspaceTaskStore(owner.root, this.stateDirectory).list();
          if (registry.tasks.some((task) => keyFor(path.join(this.stateDirectory, `${keyFor(owner.root)}-tasks`, task.id, "workspace")) === name.slice(0, 64) && task.status !== "finished")) throw new Error("Task is no longer finished");
          await this.assertSafe(file); await this.protectRoots(file); await rm(file, { recursive: true });
        } });
      } else if (name === "harnesses") {
        for (const key of await this.names(file)) {
          const directory = path.join(file, key); await this.assertSafe(directory);
          const root = roots.get(key); const store = root ? new HarnessStore(root, this.stateDirectory) : undefined;
          const runs = store ? await store.storageRuns().catch(() => []) : [];
          let primary: { bytes: number; stamp: number } | undefined;
          for (const entry of await this.names(directory)) {
            const target = path.join(directory, entry);
            if (entry === "runs.json") { const meta = await lstat(target); primary = { bytes: await this.size(target), stamp: meta.mtimeMs }; }
            else if (/\.tmp$/.test(entry)) await this.removableFile(target, "workflows");
            else if (entry.startsWith("runs")) await this.retain(target, "workflows");
            else if (entry === "quarantine") await this.retain(target, "workflows", "retained");
            else await this.retain(target, "other", "retained");
          }
          if (store && primary && runs.length) {
            const weights = runs.map((run) => Buffer.byteLength(JSON.stringify(run)));
            const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
            const mainBytes = primary.bytes;
            // Apportion only the primary file. Recovery backups and summaries remain in their measured age buckets.
            if (mainBytes && totalWeight) {
              let allocated = 0;
              runs.forEach((run, index) => {
                const share = index === runs.length - 1 ? mainBytes - allocated : Math.floor(mainBytes * weights[index]! / totalWeight); allocated += share;
                const ended = terminalRun.has(run.status) && run.completedAt;
                const segment = ended ? storageAge(Date.parse(run.completedAt!), Date.now()) : "retained";
                this.add("workflows", share, segment, index === 0 ? 1 : 0);
                if (ended) this.candidate({ category: "workflows", stamp: Date.parse(run.completedAt!), bytes: share, group: directory, remove: async (cutoff) => { await this.assertSafe(directory); await store.cleanupRunsBefore(cutoff); } });
              });
            }
          } else if (primary) this.add("workflows", primary.bytes, storageAge(primary.stamp, Date.now()));
        }
      } else if (name === "workflow-sessions") {
        // These are directory aliases, not additional copies of the workspace.
        await this.retain(file, "other", "retained");
      } else if (/-(commands|events|responses)$/.test(name)) await this.retain(file, "logs");
      else if (/^[a-f0-9]{64}-.+\.json(?:\.bak)?$/.test(name)) await this.retain(file, name.includes("sessions") || currentSessionFiles.has(name.replace(/\.bak$/, "")) ? "sessions" : "other");
      else await this.retain(file, "other", "retained");
    }
    await this.retain(this.providerDirectory, "provider", "retained");
    const versionEntries = await this.versions.entries(); const obsolete: string[] = []; let obsoleteBytes = 0;
    for (const entry of versionEntries) {
      const isRoot = [...roots.values()].some((root) => root === entry.path || root.startsWith(`${entry.path}${path.sep}`));
      const bytes = await this.size(entry.path); this.add("runtime", bytes, entry.current ? "current" : isRoot ? "retained" : "obsolete");
      (this.usage("runtime").entries ??= []).push({ path: entry.path, label: entry.label, bytes, state: entry.current ? "Current" : isRoot ? "Root workspace" : "Obsolete" });
      if (!entry.current && !isRoot) { obsolete.push(entry.path); obsoleteBytes += bytes; }
    }
    // Metadata and unrecognized files remain visible and protected, without measuring version trees twice.
    for (const directory of [this.runtimeDirectory, path.join(this.home, ".vibe-deploy")]) for (const name of await this.names(directory)) {
      const file = path.join(directory, name);
      if (versionEntries.some((entry) => entry.path === file)) continue;
      if (["releases", "sources"].includes(name) && directory.endsWith(".vibe-deploy")) { for (const child of await this.names(file)) if (!versionEntries.some((entry) => entry.path === path.join(file, child))) await this.retain(path.join(file, child), "runtime", "retained"); }
      else await this.retain(file, "runtime", "retained");
    }
    if (obsolete.length && this.versions.supported) this.candidate({ category: "runtime", mode: "versions", bytes: obsoleteBytes, stamp: 0, remove: () => this.versions.keepCurrent(obsolete, () => this.rootPaths(), (message) => { this.snapshot.message = message; }) });
    for (const name of await this.names(this.home)) if (/^\.vibe-server-[\w-]+\.log(?:\.previous)?$/.test(name)) await this.removableFile(path.join(this.home, name), "logs", name.endsWith(".previous"));
    this.snapshot.phase = "ready"; this.snapshot.updatedAt = new Date().toISOString();
    this.snapshot.message = "Usage calculated. Cleanup rechecks eligibility and refreshes totals.";
  }
}
