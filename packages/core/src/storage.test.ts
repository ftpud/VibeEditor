import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { realpath, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile, access, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessRun, StorageCategory } from "@remote-ide/protocol";
import { ServerStorage, storageAge, storageCutoffs } from "./storage.js";
import { WorkspaceTaskStore } from "./tasks.js";
import { HarnessStore } from "./harnesses.js";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
async function fixture() {
  // macOS temp paths may use /var, a symlink; keep the cleanup fixtures canonical.
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "vibe-storage-"))); temporary.push(home);
  const stateDirectory = path.join(home, ".remote-ide", "workspaces"); await mkdir(stateDirectory, { recursive: true });
  const root = path.join(home, "project"); await mkdir(root);
  const service = new ServerStorage({ home, stateDirectory, roots: () => [root], isBusy: async () => false });
  const file = async (name: string, days: number, content = "stored content") => {
    const target = path.join(stateDirectory, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
    const stamp = new Date(Date.now() - days * 86400000); await utimes(target, stamp, stamp); return target;
  };
  const scan = async () => { service.scan(); await service.drain(); expect(service.status().phase).toBe("ready"); return service.status(); };
  const clean = async (category: StorageCategory, age: "finished" | "older" | "week") => { service.cleanup({ scanId: service.status().id, category, age }); await service.drain(); expect(service.status().phase).toBe("ready"); };
  return { home, stateDirectory, root, service, file, scan, clean };
}
describe("server storage", () => {
  it("uses exclusive age buckets with server midnight and a rolling seven-day cutoff", () => {
    const now = new Date(2026, 9, 15, 12).getTime(); const cuts = storageCutoffs(now);
    expect(storageAge(cuts.today, now)).toBe("today");
    expect(storageAge(cuts.today - 1, now)).toBe("week");
    expect(storageAge(cuts.week, now)).toBe("week");
    expect(storageAge(cuts.week - 1, now)).toBe("older");
  });
  it("inventories all state without following workspace aliases and cleans only selected ages", async () => {
    const f = await fixture(); const key = hash(f.root);
    await f.file(`${key}-codex.json`, 20, JSON.stringify({ id: "current", messages: [] }));
    const older = await f.file(`${key}-codex-sessions/older.json`, 20);
    const week = await f.file(`${key}-codex-sessions/week.json`, 3);
    const today = await f.file(`${key}-codex-sessions/today.json`, 0);
    const current = await f.file(`${key}-codex-sessions/current.json`, 20);
    await f.file("unknown.json", 40);
    await mkdir(path.join(f.stateDirectory, "workflow-sessions", key), { recursive: true });
    await symlink(f.root, path.join(f.stateDirectory, "workflow-sessions", key, "alias"));
    await writeFile(path.join(f.root, "large-file"), Buffer.alloc(1024 * 1024));
    const snapshot = await f.scan();
    expect(snapshot.totalBytes).toBeLessThan(1024 * 1024);
    expect(snapshot.categories.find((row) => row.id === "sessions")?.cleanable.older).toBeGreaterThan(0);
    expect(() => f.service.cleanup({ scanId: "stale", category: "sessions", age: "older" })).toThrow("Refresh storage");
    await f.clean("sessions", "older");
    await expect(access(older)).rejects.toThrow(); await expect(access(week)).resolves.toBeUndefined();
    await f.clean("sessions", "week");
    await expect(access(week)).rejects.toThrow();
    await expect(access(today)).resolves.toBeUndefined(); await expect(access(current)).resolves.toBeUndefined();
    expect(f.service.status().totalBytes).toBeLessThan(snapshot.totalBytes);
  });
  it("retains files changed after preview and refuses a substituted symlink ancestor", async () => {
    const f = await fixture(); const directory = `${hash(f.root)}-codex-sessions`;
    const changed = await f.file(`${directory}/changed.json`, 20);
    await f.scan(); await writeFile(changed, "new conversation content");
    await f.clean("sessions", "older");
    expect(await readFile(changed, "utf8")).toBe("new conversation content");
    expect(f.service.status().warnings.some((warning) => warning.includes("changed since"))).toBe(true);
    const old = await f.file(`${directory}/old.json`, 20);
    await f.scan(); await rename(path.dirname(old), `${path.dirname(old)}-moved`);
    await symlink(`${path.dirname(old)}-moved`, path.dirname(old));
    f.service.cleanup({ scanId: f.service.status().id, category: "sessions", age: "older" }); await f.service.drain();
    expect(await readFile(path.join(`${path.dirname(old)}-moved`, "old.json"), "utf8")).toBe("stored content");
  });
  it("cleans rotated logs but preserves current server logs and provider databases", async () => {
    const f = await fixture(); const rotated = path.join(f.home, ".vibe-server-test.log.previous"), live = path.join(f.home, ".vibe-server-test.log");
    for (const file of [rotated, live]) { await writeFile(file, "server log"); const old = new Date(Date.now() - 20 * 86400000); await utimes(file, old, old); }
    await mkdir(path.join(f.home, ".codex")); await writeFile(path.join(f.home, ".codex", "state.sqlite"), "database");
    await f.scan(); await f.clean("logs", "older");
    await expect(access(rotated)).rejects.toThrow(); await expect(access(live)).resolves.toBeUndefined();
    expect(f.service.status().categories.find((row) => row.id === "provider")?.cleanable.older).toBe(0);
  });
  it("removes finished clean workspaces while preserving branches and refusing dirty or busy tasks", async () => {
    const f = await fixture();
    for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) await exec("git", ["-C", f.root, ...args]);
    await writeFile(path.join(f.root, "tracked"), "hello"); await exec("git", ["-C", f.root, "add", "."]); await exec("git", ["-C", f.root, "commit", "-m", "initial"]);
    const tasks = new WorkspaceTaskStore(f.root, f.stateDirectory);
    const finished = await tasks.create("finished", false, false, false); await tasks.setStatus(finished.id, "finished");
    const dirty = await tasks.create("dirty", false, false, false); await tasks.setStatus(dirty.id, "finished");
    await writeFile(path.join(tasks.taskPath(dirty.id), "untracked"), "keep me");
    const active = await tasks.create("active", false, false, false);
    await expect(tasks.cleanupFinished(finished.id, async () => true)).rejects.toThrow("active");
    await f.scan(); await f.clean("tasks", "finished");
    expect((await tasks.list()).tasks.map((task) => task.id), f.service.status().warnings.join("\n")).toEqual([dirty.id, active.id]);
    expect((await exec("git", ["-C", f.root, "branch", "--list", "finished"])).stdout).toContain("finished");
    expect(await readFile(path.join(tasks.taskPath(dirty.id), "untracked"), "utf8")).toBe("keep me");
  });
  it("prunes workflow records by completion date, retains active runs, and updates backups", async () => {
    const f = await fixture(); const store = new HarnessStore(f.root, f.stateDirectory);
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    const run: HarnessRun = { id: "old", harnessId: "flow", harnessVersion: 1, input: "work", status: "succeeded", createdAt: old, completedAt: old, blocks: [] };
    await store.saveRun(run); await store.saveRun({ ...run, id: "running", status: "running" });
    await store.saveRun({ ...run, id: "recent", completedAt: new Date().toISOString() });
    await f.scan(); await f.clean("workflows", "older");
    expect((await store.runs()).map((entry) => entry.id).sort()).toEqual(["recent", "running"]);
    const backup = JSON.parse(await readFile(path.join(f.stateDirectory, "harnesses", hash(f.root), "runs.json.bak"), "utf8"));
    expect(backup.runs.some((entry: HarnessRun) => entry.id === "old")).toBe(false);
  });
  it.skipIf(process.platform !== "linux")("discovers another project's tasks and protects apps launched by a different Core instance", async () => {
    const f = await fixture(); const otherRoot = path.join(f.home, "other-project"); await mkdir(otherRoot);
    await exec("git", ["-C", otherRoot, "init"]);
    await exec("git", ["-C", otherRoot, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "initial"]);
    const store = new WorkspaceTaskStore(otherRoot, f.stateDirectory);
    const task = await store.create("other-finished", false, false, false); await store.setStatus(task.id, "finished");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: store.taskPath(task.id), stdio: "ignore" });
    await once(child, "spawn");
    try {
      const snapshot = await f.scan();
      expect(snapshot.categories.find((row) => row.id === "tasks")!.cleanable.finished).toBeGreaterThan(0);
      await f.clean("tasks", "finished");
      expect((await store.list()).tasks).toHaveLength(1);
      expect(f.service.status().warnings.some((warning) => warning.includes("other-finished"))).toBe(true);
    } finally { const exited = once(child, "exit"); child.kill(); await exited; }
    await f.scan(); await f.clean("tasks", "finished");
    expect((await store.list()).tasks, f.service.status().warnings.join("\n")).toHaveLength(0);
  });
  it("retains archived conversations referenced by active workflows", async () => {
    const f = await fixture(); const archived = await f.file(`${hash(f.root)}-codex-sessions/needed.json`, 20);
    const store = new HarnessStore(f.root, f.stateDirectory);
    await store.saveRun({ id: "active", harnessId: "flow", harnessVersion: 1, input: "work", status: "running", createdAt: new Date().toISOString(), blocks: [{ blockId: "agent", status: "running", sessionId: "needed" }] });
    await f.scan(); await f.clean("sessions", "older");
    await expect(access(archived)).resolves.toBeUndefined();
    expect(f.service.status().warnings.some((warning) => warning.includes("active workflow"))).toBe(true);
  });
  it("removes inactive and unregistered workspaces only after acknowledgement, retaining active tasks and roots", async () => {
    const f = await fixture();
    await exec("git", ["-C", f.root, "init"]);
    await exec("git", ["-C", f.root, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "initial"]);
    const store = new WorkspaceTaskStore(f.root, f.stateDirectory);
    const finished = await store.create("finished", false, false, false); await store.setStatus(finished.id, "finished");
    await writeFile(path.join(store.taskPath(finished.id), "uncommitted"), "explicitly discarded");
    const orphan = await store.create("orphan", false, false, false);
    const rootTask = await store.create("registered-root", false, false, false); await store.setStatus(rootTask.id, "finished");
    const active = await store.create("active", false, false, false);
    const legacy = path.join(f.stateDirectory, `${hash(f.root)}-tasks`, "legacy-copy", "workspace");
    await mkdir(path.dirname(legacy), { recursive: true }); await exec("git", ["clone", f.root, legacy]);
    const registryFile = path.join(f.stateDirectory, `${hash(f.root)}-tasks`, "tasks.json");
    const registry = JSON.parse(await readFile(registryFile, "utf8")); registry.tasks = registry.tasks.filter((task: { id: string }) => task.id !== orphan.id); await writeFile(registryFile, JSON.stringify(registry));
    const rootsFile = path.join(f.stateDirectory, "roots-1234.json"); await writeFile(rootsFile, JSON.stringify({ roots: [{ path: f.root }, { path: store.taskPath(rootTask.id) }] }));
    const snapshot = await f.scan(); expect(snapshot.categories.find((row) => row.id === "tasks")?.segments.some((segment) => segment.id === "unregistered")).toBe(true);
    expect(() => f.service.cleanup({ scanId: snapshot.id, category: "tasks", age: "inactive" })).toThrow("Acknowledge");
    f.service.cleanup({ scanId: snapshot.id, category: "tasks", age: "inactive", discardChanges: true }); await f.service.drain();
    expect(f.service.status().phase).toBe("ready");
    for (const task of [finished, orphan]) await expect(access(store.taskPath(task.id))).rejects.toThrow();
    for (const workspace of [f.root, store.taskPath(rootTask.id), store.taskPath(active.id)]) await expect(access(workspace)).resolves.toBeUndefined();
    expect((await exec("git", ["-C", f.root, "branch", "--list", "orphan"])).stdout).toContain("orphan");
    expect((await exec("git", ["-C", f.root, "branch", "--list", "recovered/legacy-copy/HEAD"])).stdout).toContain("recovered/legacy-copy/HEAD");
  });
});
