import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkspaceTaskStore } from "./tasks.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceTaskStore", () => {
  it("copies the workspace, creates the branch, and persists selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/task-one");
    const selected = await store.select(task.id);

    expect((await store.list()).selectedTaskId).toBe(task.id);
    expect((await execFileAsync("git", ["-C", selected.workspace, "branch", "--show-current"])).stdout.trim()).toBe("feature/task-one");
    await writeFile(path.join(selected.workspace, "tracked.txt"), "task\n");
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("root\n");
    expect((await store.select()).workspace).toBe(root);
    await store.delete(task.id);
    expect((await store.list()).tasks).toEqual([]);
    await expect(access(path.dirname(selected.workspace))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
