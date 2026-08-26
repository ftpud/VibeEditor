import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkspaceTaskStore } from "./tasks.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceTaskStore", () => {
  it("creates a random task without changing the selected workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-random-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-random-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.createRandom(false);

    expect(task.branch).toMatch(/^task\/[0-9a-f]{8}$/);
    expect((await store.list()).selectedTaskId).toBeUndefined();
    expect((await execFileAsync("git", ["-C", store.taskPath(task.id), "branch", "--show-current"])).stdout.trim()).toBe(task.branch);
    await store.delete(task.id);
  });

  it("creates a linked worktree and branch, merges it, and persists selection", async () => {
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
    expect((await lstat(path.join(selected.workspace, ".git"))).isFile()).toBe(true);
    expect(await readFile(path.join(selected.workspace, ".git"), "utf8")).toContain("gitdir:");
    expect((await execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"])).stdout).toContain(`worktree ${selected.workspace}`);
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
    await expect(execFileAsync("git", ["-C", root, "show-ref", "--verify", "refs/heads/feature/task-one"])).rejects.toBeTruthy();
  });

  it("creates a task worktree from an existing branch without recreating it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-existing-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-existing-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await execFileAsync("git", ["-C", root, "branch", "feature/existing"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/existing", true);
    const selected = await store.select(task.id);

    expect(task.branch).toBe("feature/existing");
    expect((await execFileAsync("git", ["-C", selected.workspace, "branch", "--show-current"])).stdout.trim()).toBe("feature/existing");
    await store.delete(task.id);
  });

  it("carries the root working state into a new worktree without changing the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "staged.txt"), "base\n");
    await writeFile(path.join(root, "unstaged.txt"), "base\n");
    await writeFile(path.join(root, "deleted.txt"), "base\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    await writeFile(path.join(root, "staged.txt"), "staged\n");
    await execFileAsync("git", ["-C", root, "add", "staged.txt"]);
    await writeFile(path.join(root, "unstaged.txt"), "unstaged\n");
    await writeFile(path.join(root, "untracked.txt"), "untracked\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored\n");
    await rm(path.join(root, "deleted.txt"));

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/working-state");
    const workspace = store.taskPath(task.id);

    expect(await readFile(path.join(workspace, "staged.txt"), "utf8")).toBe("staged\n");
    expect(await readFile(path.join(workspace, "unstaged.txt"), "utf8")).toBe("unstaged\n");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(await readFile(path.join(workspace, "ignored.txt"), "utf8")).toBe("ignored\n");
    await expect(access(path.join(workspace, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await execFileAsync("git", ["-C", workspace, "diff", "--cached", "--name-only"])).stdout).toContain("staged.txt");
    expect((await execFileAsync("git", ["-C", workspace, "status", "--porcelain"])).stdout).toContain("unstaged.txt");
    expect(await readFile(path.join(root, "unstaged.txt"), "utf8")).toBe("unstaged\n");
  });

  it("leaves node_modules out of the task workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await mkdir(path.join(root, "node_modules", "some-dep"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "some-dep", "index.js"), "module.exports = 1;\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/task-dependencies");
    const workspace = store.taskPath(task.id);

    await expect(access(path.join(workspace, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "node_modules", "some-dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("removes node_modules symlinks from existing task worktrees", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await mkdir(path.join(root, "node_modules"));
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/existing-symlink");
    const workspace = store.taskPath(task.id);
    await symlink(path.join(root, "node_modules"), path.join(workspace, "node_modules"), "dir");

    await store.list();

    await expect(access(path.join(workspace, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(root, "node_modules"))).isDirectory()).toBe(true);
  });

  it("automatically migrates a legacy copied repository and preserves its changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/legacy");
    const workspace = store.taskPath(task.id);
    await execFileAsync("git", ["-C", root, "worktree", "remove", "--force", workspace]);
    await execFileAsync("git", ["clone", "--no-local", root, workspace]);
    await execFileAsync("git", ["-C", workspace, "switch", "-c", task.branch, `origin/${task.branch}`]);
    await writeFile(path.join(workspace, "tracked.txt"), "legacy staged\n");
    await execFileAsync("git", ["-C", workspace, "add", "tracked.txt"]);
    await writeFile(path.join(workspace, "untracked.txt"), "legacy untracked\n");

    await store.list();

    expect((await lstat(path.join(workspace, ".git"))).isFile()).toBe(true);
    expect(await readFile(path.join(workspace, "tracked.txt"), "utf8")).toBe("legacy staged\n");
    expect(await readFile(path.join(workspace, "untracked.txt"), "utf8")).toBe("legacy untracked\n");
    expect((await execFileAsync("git", ["-C", workspace, "diff", "--cached", "--name-only"])).stdout.trim()).toBe("tracked.txt");
  });
});
