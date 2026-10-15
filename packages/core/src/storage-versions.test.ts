import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageVersions } from "./storage-versions.js";
import { StorageProcesses, type StorageProcess } from "./storage-processes.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "vibe-versions-")); temporary.push(home);
  const runtimeDirectory = path.join(home, ".remote-ide", "codex-runtime");
  const currentRuntime = path.join(runtimeDirectory, "installation-current"), oldRuntime = path.join(runtimeDirectory, "installation-old");
  const deployment = path.join(home, ".vibe-deploy");
  const currentRelease = path.join(deployment, "releases", `${"a".repeat(40)}-node137`), oldRelease = path.join(deployment, "releases", `${"b".repeat(40)}-node137`);
  const source = path.join(deployment, "sources", "c".repeat(64));
  for (const directory of [currentRuntime, oldRuntime, currentRelease, oldRelease, source]) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "payload"), "stored version"); }
  for (const packageName of ["@agentclientprotocol/codex-acp", "@openai/codex"]) {
    const directory = path.join(currentRuntime, "node_modules", packageName); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "1.0.0" }));
  }
  const closeOtherSessions = vi.fn(async () => {});
  const service = new StorageVersions({ home, runtimeDirectory, currentDeployment: () => currentRelease, currentRuntime: () => currentRuntime, closeOtherSessions });
  return { home, runtimeDirectory, deployment, currentRuntime, oldRuntime, currentRelease, oldRelease, source, closeOtherSessions, service };
}
describe("version retention", () => {
  it("stops peers before deleting old versions and keeps the actual loaded runtime and release", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, ".vibe-server-other.release.previous"), path.basename(f.oldRelease));
    const entries = await f.service.entries(); expect(entries.filter((entry) => entry.current)).toHaveLength(2);
    f.closeOtherSessions.mockImplementation(async () => { await expect(access(f.oldRelease)).resolves.toBeUndefined(); });
    await f.service.keepCurrent(entries.filter((entry) => !entry.current).map((entry) => entry.path), async () => [], () => {});
    expect(f.closeOtherSessions).toHaveBeenCalledOnce();
    for (const file of [f.currentRuntime, f.currentRelease]) await expect(access(file)).resolves.toBeUndefined();
    for (const file of [f.oldRuntime, f.oldRelease, f.source]) await expect(access(file)).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(f.runtimeDirectory, "current.json"), "utf8")).directory).toBe(f.currentRuntime);
    await expect(access(path.join(f.home, ".vibe-server-other.release.previous"))).rejects.toThrow();
  });
  it("preserves everything if peer shutdown fails or deployment is in progress", async () => {
    const f = await fixture(); f.closeOtherSessions.mockRejectedValue(new Error("peer did not stop"));
    await expect(f.service.keepCurrent([f.oldRuntime, f.oldRelease], async () => [], () => {})).rejects.toThrow("peer did not stop");
    await expect(access(f.oldRelease)).resolves.toBeUndefined(); await expect(access(f.oldRuntime)).resolves.toBeUndefined();
    await mkdir(path.join(f.deployment, "provision.lock"));
    await expect(f.service.keepCurrent([f.oldRelease], async () => [], () => {})).rejects.toThrow("provisioning");
    await expect(access(f.oldRelease)).resolves.toBeUndefined();
  });
  it("retains registered roots, substituted symlinks and versions absent from the preview", async () => {
    const f = await fixture();
    await f.service.keepCurrent([f.oldRelease], async () => [f.oldRelease], () => {});
    await expect(access(f.oldRelease)).resolves.toBeUndefined(); await expect(access(f.oldRuntime)).resolves.toBeUndefined();
    await rm(f.oldRelease, { recursive: true }); await symlink(f.currentRelease, f.oldRelease);
    await f.service.keepCurrent([f.oldRelease], async () => [], () => {});
    await expect(access(f.currentRelease)).resolves.toBeUndefined();
  });
});
describe("cross-instance process shutdown", () => {
  const row = (pid: number, parentPid: number, core = false): StorageProcess => ({ pid, parentPid, birth: String(pid), core, cwd: "/project", executable: "/usr/bin/node", argv: ["node", "app.js"] });
  it("closes peer Cores and their descendants while preserving this Core, ancestors, and unrelated processes", async () => {
    let rows = [row(1, 0), row(2, 1, true), row(3, 1, true), row(4, 3), row(5, 1)]; let time = 0;
    const signal = vi.fn(async (target: StorageProcess) => { rows = rows.filter((current) => current.pid !== target.pid); });
    const controller = new StorageProcesses({ self: 2, snapshot: async () => rows, signal, now: () => time, pause: async () => { time += 1000; } });
    await controller.closeOtherSessions([], () => {});
    expect(signal.mock.calls.map(([target]) => target.pid).sort()).toEqual([3, 4]);
    expect(rows.map((item) => item.pid)).toEqual([1, 2, 5]);
  });
  it("does not signal a recycled PID and refuses to delete versions still used by unrelated processes", async () => {
    let calls = 0; const old = row(3, 1, true), replacement = { ...row(3, 1), birth: "new" };
    const unrelated = { ...row(5, 1), cwd: "/old-version" }; const signal = vi.fn(async () => {}); let time = 0;
    const controller = new StorageProcesses({ self: 2, snapshot: async () => ++calls === 1 ? [row(2, 1, true), old, unrelated] : [row(2, 1, true), replacement, unrelated], signal, now: () => time, pause: async () => { time += 1000; } });
    await expect(controller.closeOtherSessions(["/old-version"], () => {})).rejects.toThrow("PID 5");
    expect(signal).toHaveBeenCalledTimes(1); // Initial request only; no signal to the replacement.
  });
});
