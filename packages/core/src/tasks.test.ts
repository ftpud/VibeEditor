import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
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
    const rootBranch = (await execFileAsync("git", ["-C", root, "branch", "--show-current"])).stdout.trim();

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/task-one");
    expect(task.baseBranch).toBe(rootBranch);
    const selected = await store.select(task.id);

    expect((await store.list()).selectedTaskId).toBe(task.id);
    expect((await execFileAsync("git", ["-C", selected.workspace, "branch", "--show-current"])).stdout.trim()).toBe("feature/task-one");
    expect((await execFileAsync("git", ["-C", selected.workspace, "rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim()).toBe(rootBranch);
    await writeFile(path.join(selected.workspace, "tracked.txt"), "task\n");
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("root\n");
    await execFileAsync("git", ["-C", selected.workspace, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", selected.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "task change"]);
    expect((await store.merge(task.id)).targetBranch).toBe(rootBranch);
    expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("task\n");
    expect((await store.select()).workspace).toBe(root);
    await store.delete(task.id);
    expect((await store.list()).tasks).toEqual([]);
    await expect(access(path.dirname(selected.workspace))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("symlinks node_modules into the task workspace instead of copying it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await mkdir(path.join(root, "node_modules", "some-dep"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "some-dep", "index.js"), "module.exports = 1;\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/task-symlink");
    const workspace = store.taskPath(task.id);

    const stats = await lstat(path.join(workspace, "node_modules"));
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await realpath(path.join(workspace, "node_modules"))).toBe(await realpath(path.join(root, "node_modules")));
    expect(await readFile(path.join(workspace, "node_modules", "some-dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });
});
