import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorkspaceTaskStore } from "./tasks.js";
import { WorkspaceStateStore } from "./workspace-state.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceTaskStore", () => {
  it("rewrites only an explicit task's unpushed tip message while preserving its contents and working state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-git-message-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-git-message-state-"));
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    const rootHead = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const store = new WorkspaceTaskStore(root, state);
    const first = await store.create("feature/reword-one", false, false, false);
    const second = await store.create("feature/reword-two", false, false, false);
    const firstWorkspace = store.taskPath(first.id);
    const secondWorkspace = store.taskPath(second.id);

    await expect(store.updateGitCommitMessage(first.id, "Too early")).rejects.toThrow("has no task commit to update");
    await writeFile(path.join(firstWorkspace, "tracked.txt"), "committed\n");
    await execFileAsync("git", ["-C", firstWorkspace, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", firstWorkspace, "commit", "-m", "Old message"]);
    const oldCommit = (await execFileAsync("git", ["-C", firstWorkspace, "rev-parse", "HEAD"])).stdout.trim();
    const oldTree = (await execFileAsync("git", ["-C", firstWorkspace, "show", "-s", "--format=%T", "HEAD"])).stdout.trim();
    await writeFile(path.join(firstWorkspace, "staged.txt"), "staged\n");
    await execFileAsync("git", ["-C", firstWorkspace, "add", "staged.txt"]);
    await writeFile(path.join(firstWorkspace, "unstaged.txt"), "unstaged\n");
    const statusBefore = (await execFileAsync("git", ["-C", firstWorkspace, "status", "--porcelain"])).stdout;
    const message = "New subject\n\nDetailed body";

    await expect(store.updateGitCommitMessage(first.id, message)).resolves.toEqual({
      task: first, previousCommit: oldCommit, commit: expect.not.stringMatching(oldCommit), previousMessage: "Old message", message
    });
    expect((await execFileAsync("git", ["-C", firstWorkspace, "log", "-1", "--format=%B"])).stdout.trimEnd()).toBe(message);
    expect((await execFileAsync("git", ["-C", firstWorkspace, "show", "-s", "--format=%T", "HEAD"])).stdout.trim()).toBe(oldTree);
    expect((await execFileAsync("git", ["-C", firstWorkspace, "status", "--porcelain"])).stdout).toBe(statusBefore);
    expect((await execFileAsync("git", ["-C", secondWorkspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(rootHead);
    expect((await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(rootHead);
    await expect(store.updateGitCommitMessage("missing-task", "Message")).rejects.toThrow("does not exist");
    await expect(store.updateGitCommitMessage(first.id, " \n\t ")).rejects.toThrow("must contain at least one non-whitespace character");

    await store.delete(first.id);
    await store.delete(second.id);
  });

  it("refuses to rewrite a task tip already published to its upstream", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-published-message-"));
    const remote = path.join(parent, "remote.git");
    const root = path.join(parent, "root");
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-published-state-"));
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["clone", remote, root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await execFileAsync("git", ["-C", root, "push", "-u", "origin", "HEAD"]);
    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/published-message", false, false, false);
    const workspace = store.taskPath(task.id);
    await writeFile(path.join(workspace, "tracked.txt"), "task\n");
    await execFileAsync("git", ["-C", workspace, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", workspace, "commit", "-m", "Published message"]);
    await execFileAsync("git", ["-C", workspace, "push", "-u", "origin", "HEAD"]);
    const head = (await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim();

    await expect(store.updateGitCommitMessage(task.id, "Do not rewrite")).rejects.toThrow("already published");
    expect((await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    await store.delete(task.id);
  });

  it("sets, overwrites, and isolates multiline commit message drafts by current task workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-message-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-message-state-"));
    await execFileAsync("git", ["init", root]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
    const store = new WorkspaceTaskStore(root, state);
    const first = await store.create("feature/message-one", false, false, false);
    const second = await store.create("feature/message-two", false, false, false);
    const firstState = new WorkspaceStateStore(store.taskPath(first.id), state);
    const secondState = new WorkspaceStateStore(store.taskPath(second.id), state);

    await expect(store.setCommitMessage(store.taskPath(first.id), "Initial draft")).resolves.toMatchObject({ task: first, overwritten: false });
    const multiline = "Subject\n\nBody line one\n  Body line two\n";
    await expect(store.setCommitMessage(store.taskPath(first.id), multiline)).resolves.toEqual({ task: first, message: multiline, overwritten: true });
    await expect(firstState.load()).resolves.toMatchObject({ gitCommitMessage: multiline });
    await expect(secondState.load()).resolves.toEqual({ openFiles: [] });
    await expect(store.setCommitMessage(root, "Wrong task")).rejects.toThrow("requires a current Vibe Editor task workspace");
    await expect(store.setCommitMessage(store.taskPath(first.id), " \n\t ")).rejects.toThrow("must contain at least one non-whitespace character");
    await expect(store.setCommitMessage(store.taskPath(first.id), "x".repeat(10_001))).rejects.toThrow("must be at most 10000 characters");
    await expect(secondState.load()).resolves.toEqual({ openFiles: [] });

    await store.delete(first.id);
    await store.delete(second.id);
  });

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
    await expect(execFileAsync("git", ["-C", selected.workspace, "rev-parse", "--abbrev-ref", "@{upstream}"])).rejects.toBeTruthy();
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

  it("creates a new task from the local root branch and configures push for the matching remote branch", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-push-"));
    const remote = path.join(parent, "remote.git");
    const root = path.join(parent, "root");
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-push-state-"));
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["clone", remote, root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await writeFile(path.join(root, "tracked.txt"), "root\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
    await execFileAsync("git", ["-C", root, "push", "-u", "origin", "HEAD"]);
    const rootBranch = (await execFileAsync("git", ["-C", root, "branch", "--show-current"])).stdout.trim();
    const rootHead = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/pushable");
    const workspace = store.taskPath(task.id);

    expect(task.baseBranch).toBe(rootBranch);
    expect((await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"])).stdout.trim()).toBe(rootHead);
    expect((await execFileAsync("git", ["-C", workspace, "config", "--get", "branch.feature/pushable.remote"])).stdout.trim()).toBe("origin");
    expect((await execFileAsync("git", ["-C", workspace, "config", "--get", "branch.feature/pushable.merge"])).stdout.trim()).toBe("refs/heads/feature/pushable");
    await execFileAsync("git", ["-C", workspace, "push"]);
    expect((await execFileAsync("git", ["-C", remote, "show-ref", "--verify", "refs/heads/feature/pushable"])).stdout).toContain("refs/heads/feature/pushable");
    await store.delete(task.id);
  });

  it("commits task changes and preserves uncommitted main workspace changes while rebasing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-smart-merge-root-"));
    const state = await mkdtemp(path.join(os.tmpdir(), "remote-ide-task-smart-merge-state-"));
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await writeFile(path.join(root, "task.txt"), "base\n");
    await writeFile(path.join(root, "main.txt"), "base\n");
    await writeFile(path.join(root, "staged.txt"), "base\n");
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);

    const store = new WorkspaceTaskStore(root, state);
    const task = await store.create("feature/smart-merge");
    const workspace = store.taskPath(task.id);
    await writeFile(path.join(workspace, "task.txt"), "task change\n");
    await writeFile(path.join(workspace, "new-task.txt"), "new task file\n");
    await writeFile(path.join(root, "main.txt"), "committed on main\n");
    await execFileAsync("git", ["-C", root, "add", "main.txt"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "main advances"]);
    const mainHead = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(path.join(root, "staged.txt"), "staged main work\n");
    await execFileAsync("git", ["-C", root, "add", "staged.txt"]);
    await writeFile(path.join(root, "local.txt"), "uncommitted main work\n");

    await store.merge(task.id);

    expect(await readFile(path.join(root, "task.txt"), "utf8")).toBe("task change\n");
    expect(await readFile(path.join(root, "new-task.txt"), "utf8")).toBe("new task file\n");
    expect(await readFile(path.join(root, "main.txt"), "utf8")).toBe("committed on main\n");
    expect(await readFile(path.join(root, "staged.txt"), "utf8")).toBe("staged main work\n");
    expect(await readFile(path.join(root, "local.txt"), "utf8")).toBe("uncommitted main work\n");
    expect((await execFileAsync("git", ["-C", root, "status", "--porcelain"])).stdout).toContain("?? local.txt");
    expect((await execFileAsync("git", ["-C", root, "diff", "--cached", "--name-only"])).stdout.trim()).toBe("staged.txt");
    expect((await execFileAsync("git", ["-C", root, "log", "-1", "--pretty=%s"])).stdout.trim()).toBe("Complete task: feature/smart-merge");
    expect((await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD^1"])).stdout.trim()).toBe(mainHead);
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
