import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serializedRootMutation } from "./root-mutation.js";

const exec = promisify(execFile);
let workspace: string;
let lock: string;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "vibe-lock-"));
  await exec("git", ["init", workspace]);
  lock = path.join(workspace, ".git", "vibe-editor-root-mutation.lock");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(workspace, { recursive: true, force: true }); });

async function owner(pid: number, hostname = os.hostname()) {
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid, hostname, token: "previous" }));
}

describe("repository mutation locking", () => {
  it("serializes operations and releases the lock after an error", async () => {
    const order: string[] = [];
    const first = serializedRootMutation(workspace, async () => {
      order.push("first");
      expect(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
      throw new Error("operation failed");
    });
    const second = serializedRootMutation(workspace, async () => { order.push("second"); return 42; });
    await expect(first).rejects.toThrow("operation failed");
    await expect(second).resolves.toBe(42);
    expect(order).toEqual(["first", "second"]);
    await expect(readFile(path.join(lock, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a lock left by a terminated process", async () => {
    // Machine-readable output must not acquire ANSI colors from CI's environment.
    const { stdout } = await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { env: { ...process.env, FORCE_COLOR: "1" } });
    expect(stdout).toMatch(/^\d+$/);
    await owner(Number(stdout));
    await expect(serializedRootMutation(workspace, async () => "recovered")).resolves.toBe("recovered");
  });

  it.each(["live", "foreign", "unknown", "empty"])("preserves a %s lock and reports its owner", async (kind) => {
    if (kind === "empty") await mkdir(lock);
    else if (kind === "unknown") { await mkdir(lock); await writeFile(path.join(lock, "unrecognized"), "legacy"); }
    else await owner(process.pid, kind === "foreign" ? "another-host" : os.hostname());
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 30_001);
    const operation = vi.fn();
    await expect(serializedRootMutation(workspace, operation)).rejects.toThrow(/Repository is locked by/);
    expect(operation).not.toHaveBeenCalled();
    if (kind === "live" || kind === "foreign") expect(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token).toBe("previous");
  });
});
