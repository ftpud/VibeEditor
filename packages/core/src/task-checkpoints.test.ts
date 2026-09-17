import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskCheckpointStore } from "./task-checkpoints.js";

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "task-checkpoints-")); roots.push(root); const workspace = path.join(root, "repo");
  await exec("git", ["init", workspace]); await exec("git", ["-C", workspace, "config", "user.email", "test@example.com"]); await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
  await writeFile(path.join(workspace, "tracked.txt"), "before\n"); await exec("git", ["-C", workspace, "add", "."]); await exec("git", ["-C", workspace, "commit", "-m", "base"]);
  return { workspace, store: new TaskCheckpointStore(workspace, path.join(root, "state")) };
}

describe("TaskCheckpointStore", () => {
  it("groups changes by prompt, persists binary/untracked/deletions, and does not mutate Git history", async () => {
    const { workspace, store } = await fixture(); const head = (await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();
    const id = await store.begin("codex", "Change files", "session-1", "prompt-1");
    await writeFile(path.join(workspace, "tracked.txt"), "after\n"); await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
    await store.complete(id, "completed");
    const reloaded = new TaskCheckpointStore(workspace, path.join(path.dirname(workspace), "state")); const history = await reloaded.history();
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ id, promptId: "prompt-1", prompt: "Change files", sessionId: "session-1", status: "completed" });
    expect(history[0]!.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "tracked.txt", status: "M", binary: false }), expect.objectContaining({ path: "binary.bin", status: "A", binary: true })]));
    expect(await reloaded.diff(id, "tracked.txt")).toEqual({ originalContent: "before\n", modifiedContent: "after\n", binary: false, truncated: false });
    expect((await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
  });

  it("applies checkpoint files with a three-way comparison and never changes HEAD or the index", async () => {
    const { workspace, store } = await fixture(); const id = await store.begin("codex", "Delete and add");
    await rm(path.join(workspace, "tracked.txt")); await writeFile(path.join(workspace, "new.txt"), "snapshot\n"); await store.complete(id, "completed");
    const head = (await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim(); await exec("git", ["-C", workspace, "add", "new.txt"]); const index = (await exec("git", ["-C", workspace, "diff", "--cached"])).stdout;
    await writeFile(path.join(workspace, "tracked.txt"), "later\n"); await writeFile(path.join(workspace, "new.txt"), "later\n");
    const result = await store.restore(id); expect(result.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" }), expect.objectContaining({ path: "new.txt" })])); await expect(readFile(path.join(workspace, "new.txt"), "utf8")).resolves.toBe("later\n"); await expect(readFile(path.join(workspace, "tracked.txt"), "utf8")).resolves.toBe("later\n");
    expect((await exec("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await exec("git", ["-C", workspace, "diff", "--cached"])).stdout).toBe(index);
  });

  it("accepts an unchanged checkpoint file without touching staged content", async () => {
    const { workspace, store } = await fixture(); const id = await store.begin("codex", "Edit"); await writeFile(path.join(workspace, "tracked.txt"), "after\n"); await store.complete(id, "completed");
    await exec("git", ["-C", workspace, "add", "tracked.txt"]); const index = (await exec("git", ["-C", workspace, "diff", "--cached"])).stdout; await writeFile(path.join(workspace, "tracked.txt"), "before\n");
    const result = await store.review(id, ["tracked.txt"]); expect(result).toMatchObject({ applied: ["tracked.txt"], conflicts: [] }); await expect(readFile(path.join(workspace, "tracked.txt"), "utf8")).resolves.toBe("after\n"); expect((await exec("git", ["-C", workspace, "diff", "--cached"])).stdout).toBe(index);
  });

  it("persists and closes an orphaned running checkpoint after Core recovery", async () => {
    const { workspace, store } = await fixture(); const id = await store.begin("copilot", "Work across restart"); await writeFile(path.join(workspace, "tracked.txt"), "recovered\n");
    const restarted = new TaskCheckpointStore(workspace, path.join(path.dirname(workspace), "state")); await restarted.recover();
    expect((await restarted.history())[0]).toMatchObject({ id, status: "interrupted", files: [expect.objectContaining({ path: "tracked.txt", status: "M" })] });
  });

  it("keeps a compact redacted handoff summary with usage and the resulting commit", async () => {
    const { store } = await fixture(); const id = await store.begin("codex", "Use api_key=super-secret-value", "session", "prompt", { model: "model-a", reasoning: "low", agent: { name: "Oleg", fingerprint: "agent" }, attachments: [{ name: "brief.md", kind: "resource" }] });
    await store.complete(id, "completed", { usage: { total: 10, input: 4, output: 6 } });
    const checkpoint = (await store.history())[0]!;
    expect(checkpoint.prompt).toContain("[REDACTED]");
    expect(checkpoint.provenance).toMatchObject({ model: "model-a", agent: { name: "Oleg" }, attachments: [{ name: "brief.md" }], usage: { total: 10 }, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});
