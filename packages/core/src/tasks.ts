import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoreError } from "./errors.js";
import { WorkspaceStateStore } from "./workspace-state.js";

const execFileAsync = promisify(execFile);
export type WorkspaceTask = { id: string; name: string; branch: string; baseBranch: string };
export type TaskCommitMessageUpdate = { task: WorkspaceTask; message: string; overwritten: boolean };
export type TaskGitCommitMessageUpdate = { task: WorkspaceTask; previousCommit: string; commit: string; previousMessage: string; message: string };
type Registry = { selectedTaskId?: string; tasks: WorkspaceTask[] };

export class WorkspaceTaskStore {
  private readonly directory: string;
  private readonly registryFile: string;

  constructor(private readonly rootWorkspace: string, private readonly stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.directory = path.join(stateDirectory, `${key}-tasks`);
    this.registryFile = path.join(this.directory, "tasks.json");
  }

  async list(): Promise<Registry> {
    try {
      const value = JSON.parse(await readFile(this.registryFile, "utf8")) as Registry;
      if (!Array.isArray(value.tasks)) throw new Error("Invalid task registry");
      const validTasks = value.tasks.filter(isTask);
      const fallbackBaseBranch = validTasks.some((task) => !task.baseBranch) ? await this.rootBranch() : "";
      const tasks = validTasks.map((task) => ({ ...task, baseBranch: task.baseBranch || fallbackBaseBranch }));
      for (const task of tasks) {
        await this.migrateLegacyCopy(task);
        await this.removeSharedNodeModules(this.taskPath(task.id));
      }
      return { tasks, ...(value.selectedTaskId && tasks.some((task) => task.id === value.selectedTaskId) ? { selectedTaskId: value.selectedTaskId } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [] };
      if (error instanceof CoreError) throw error;
      throw new CoreError("READ_FAILED", `Could not read tasks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async create(branch: string, existing = false, remote = false, select = true): Promise<WorkspaceTask> {
    const requested = branch.trim();
    const name = remote ? requested.split("/").slice(1).join("/") : requested;
    if (!name || name.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..") || name.endsWith("/") || name.endsWith(".")) throw new CoreError("INVALID_REQUEST", "Invalid Git branch name");
    const registry = await this.list();
    if (registry.tasks.some((task) => task.branch === name)) throw new CoreError("INVALID_REQUEST", `A task already uses branch ${name}`);
    const exists = await this.branchExists(name);
    if (!existing && exists) throw new CoreError("INVALID_REQUEST", `Git branch ${name} already exists. Select it from the existing branches list.`);
    if (existing && !remote && !exists) throw new CoreError("INVALID_REQUEST", `Git branch ${name} no longer exists`);
    const task: WorkspaceTask = { id: crypto.randomUUID(), name, branch: name, baseBranch: await this.rootBranch() };
    const destination = this.taskPath(task.id);
    let createdBranch = false;
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await execFileAsync("git", ["-C", this.rootWorkspace, "worktree", "add", "--detach", destination, task.baseBranch], { encoding: "utf8" });
      if (remote) {
        await execFileAsync("git", ["-C", destination, "switch", "--track", "-c", name, requested], { encoding: "utf8" });
        createdBranch = true;
      } else if (existing) await execFileAsync("git", ["-C", destination, "switch", name], { encoding: "utf8" });
      else {
        await execFileAsync("git", ["-C", destination, "switch", "-C", name], { encoding: "utf8" });
        createdBranch = true;
        await this.configureNewBranchPush(name);
      }
      await this.copyWorkspaceState(this.rootWorkspace, destination);
      await this.save({ tasks: [...registry.tasks, task], ...(select ? { selectedTaskId: task.id } : registry.selectedTaskId ? { selectedTaskId: registry.selectedTaskId } : {}) });
      return task;
    } catch (error) {
      await this.removeWorktree(destination);
      if (createdBranch && await this.branchExists(name)) await execFileAsync("git", ["-C", this.rootWorkspace, "branch", "-D", name], { encoding: "utf8" }).catch(() => undefined);
      await rm(path.dirname(destination), { recursive: true, force: true });
      throw new CoreError("GIT_FAILED", `Could not create task worktree: ${gitError(error)}`);
    }
  }

  async createRandom(select = true): Promise<WorkspaceTask> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const branch = `task/${crypto.randomUUID().slice(0, 8)}`;
      if (!await this.branchExists(branch)) return this.create(branch, false, false, select);
    }
    throw new CoreError("GIT_FAILED", "Could not generate a unique task branch name");
  }

  async select(taskId?: string): Promise<{ workspace: string; registry: Registry }> {
    const registry = await this.list();
    if (taskId && !registry.tasks.some((task) => task.id === taskId)) throw new CoreError("INVALID_REQUEST", "Task does not exist");
    const next = { tasks: registry.tasks, ...(taskId ? { selectedTaskId: taskId } : {}) };
    await this.save(next);
    return { workspace: taskId ? this.taskPath(taskId) : this.rootWorkspace, registry: next };
  }

  async setCommitMessage(workspace: string, message: string): Promise<TaskCommitMessageUpdate> {
    if (typeof message !== "string" || !message.trim()) throw new CoreError("INVALID_REQUEST", "Commit message must contain at least one non-whitespace character");
    if (message.length > 10_000) throw new CoreError("INVALID_REQUEST", "Commit message must be at most 10000 characters");
    const registry = await this.list();
    const resolvedWorkspace = path.resolve(workspace);
    const task = registry.tasks.find((item) => path.resolve(this.taskPath(item.id)) === resolvedWorkspace);
    if (!task) throw new CoreError("INVALID_REQUEST", "set_commit_message requires a current Vibe Editor task workspace");
    const state = new WorkspaceStateStore(this.taskPath(task.id), this.stateDirectory);
    const options = await state.load();
    const overwritten = options.gitCommitMessage !== undefined;
    await state.save({ ...options, gitCommitMessage: message });
    return { task, message, overwritten };
  }

  async updateGitCommitMessage(taskId: string, message: string): Promise<TaskGitCommitMessageUpdate> {
    validateCommitMessage(message);
    const registry = await this.list();
    const task = registry.tasks.find((item) => item.id === taskId);
    if (!task) throw new CoreError("INVALID_REQUEST", `Task '${taskId}' does not exist`);
    const workspace = this.taskPath(task.id);
    try {
      const branch = (await execFileAsync("git", ["-C", workspace, "branch", "--show-current"], { encoding: "utf8" })).stdout.trim();
      if (branch !== task.branch) throw new CoreError("GIT_FAILED", `Task '${taskId}' worktree is not on its registered branch '${task.branch}'`);

      let previousCommit: string;
      try { previousCommit = (await execFileAsync("git", ["-C", workspace, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" })).stdout.trim(); }
      catch { throw new CoreError("INVALID_REQUEST", `Task '${taskId}' has no commit to update`); }

      const taskCommitCount = Number((await execFileAsync("git", ["-C", workspace, "rev-list", "--count", `${task.baseBranch}..HEAD`], { encoding: "utf8" })).stdout.trim());
      if (!taskCommitCount) throw new CoreError("INVALID_REQUEST", `Task '${taskId}' has no task commit to update`);

      if (await gitRefExists(workspace, "@{upstream}")) {
        try {
          await execFileAsync("git", ["-C", workspace, "merge-base", "--is-ancestor", "HEAD", "@{upstream}"], { encoding: "utf8" });
          throw new CoreError("INVALID_REQUEST", `Task '${taskId}' tip is already published to its upstream; refusing to rewrite it`);
        } catch (error) {
          if (error instanceof CoreError) throw error;
          if ((error as { code?: number }).code !== 1) throw error;
        }
      }

      const [tree, parents, author, previousMessage] = await Promise.all([
        execFileAsync("git", ["-C", workspace, "show", "-s", "--format=%T", "HEAD"], { encoding: "utf8" }),
        execFileAsync("git", ["-C", workspace, "show", "-s", "--format=%P", "HEAD"], { encoding: "utf8" }),
        execFileAsync("git", ["-C", workspace, "show", "-s", "--format=%an%x00%ae%x00%aI", "HEAD"], { encoding: "utf8" }),
        execFileAsync("git", ["-C", workspace, "show", "-s", "--format=%B", "HEAD"], { encoding: "utf8" })
      ]);
      const [authorName, authorEmail, authorDate] = author.stdout.trimEnd().split("\0");
      if (!authorName || !authorEmail || !authorDate) throw new Error("Could not read the current commit author");
      const messageFile = path.join(path.dirname(workspace), `commit-message-${process.pid}-${crypto.randomUUID()}.txt`);
      await writeFile(messageFile, message, "utf8");
      let commit: string;
      try {
        const parentArgs = parents.stdout.trim().split(/\s+/).filter(Boolean).flatMap((parent) => ["-p", parent]);
        commit = (await execFileAsync("git", ["-C", workspace, "commit-tree", tree.stdout.trim(), ...parentArgs, "-F", messageFile], {
          encoding: "utf8",
          env: { ...process.env, GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_AUTHOR_DATE: authorDate }
        })).stdout.trim();
      } finally {
        await rm(messageFile, { force: true });
      }
      await execFileAsync("git", ["-C", workspace, "update-ref", "-m", "vibe-editor: update task commit message", `refs/heads/${task.branch}`, commit, previousCommit], { encoding: "utf8" });
      return { task, previousCommit, commit, previousMessage: previousMessage.stdout.replace(/\n+$/, ""), message };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("GIT_FAILED", `Could not update commit message for task '${taskId}': ${gitError(error)}`);
    }
  }

  async merge(taskId: string, strategy: "merge" | "smart" = "smart"): Promise<{ targetBranch: string }> {
    const registry = await this.list();
    const task = registry.tasks.find((item) => item.id === taskId);
    if (!task) throw new CoreError("INVALID_REQUEST", "Task does not exist");
    const taskWorkspace = this.taskPath(taskId);
    let stashedRootChanges = false;
    let merged = false;
    try {
      const [rootStatus, targetBranch] = await Promise.all([
        execFileAsync("git", ["-C", this.rootWorkspace, "status", "--porcelain"], { encoding: "utf8" }),
        execFileAsync("git", ["-C", this.rootWorkspace, "branch", "--show-current"], { encoding: "utf8" }),
      ]);
      const branch = targetBranch.stdout.trim();
      if (!branch) throw new CoreError("GIT_FAILED", "Main workspace is in detached HEAD state. Check out a branch before merging.");

      await execFileAsync("git", ["-C", taskWorkspace, "add", "--all"], { encoding: "utf8" });
      const staged = (await execFileAsync("git", ["-C", taskWorkspace, "diff", "--cached", "--name-only"], { encoding: "utf8" })).stdout.trim();
      if (staged) await execFileAsync("git", ["-C", taskWorkspace, "commit", "-m", `Complete task: ${task.name}`], { encoding: "utf8" });

      if (strategy === "merge") {
        if (rootStatus.stdout.trim()) throw new CoreError("GIT_FAILED", "Main workspace has uncommitted changes. Use Smart merge to preserve them automatically.");
        try { await execFileAsync("git", ["-C", this.rootWorkspace, "merge", "--no-edit", task.branch], { encoding: "utf8" }); }
        catch (mergeError) {
          await execFileAsync("git", ["-C", this.rootWorkspace, "merge", "--abort"], { encoding: "utf8" }).catch(() => undefined);
          throw mergeError;
        }
        return { targetBranch: branch };
      }

      if (rootStatus.stdout.trim()) {
        await execFileAsync("git", ["-C", this.rootWorkspace, "stash", "push", "--include-untracked", "--message", `remote-ide: merge ${task.name}`], { encoding: "utf8" });
        stashedRootChanges = true;
      }

      try { await execFileAsync("git", ["-C", taskWorkspace, "rebase", branch], { encoding: "utf8" }); }
      catch (rebaseError) {
        await execFileAsync("git", ["-C", taskWorkspace, "rebase", "--abort"], { encoding: "utf8" }).catch(() => undefined);
        throw rebaseError;
      }
      await execFileAsync("git", ["-C", this.rootWorkspace, "merge", "--ff-only", task.branch], { encoding: "utf8" });
      merged = true;
      if (stashedRootChanges) {
        stashedRootChanges = false;
        try { await execFileAsync("git", ["-C", this.rootWorkspace, "stash", "pop", "--index"], { encoding: "utf8" }); }
        catch (restoreError) {
          throw new CoreError("GIT_FAILED", `The task was merged, but the main workspace changes could not be restored cleanly. Resolve the working tree conflicts; the backup remains in Git stash. ${gitError(restoreError)}`);
        }
      }
      return { targetBranch: branch };
    } catch (error) {
      if (stashedRootChanges) {
        stashedRootChanges = false;
        try {
          await execFileAsync("git", ["-C", this.rootWorkspace, "stash", "pop", "--index"], { encoding: "utf8" });
        } catch (restoreError) {
          const action = merged ? "The task was merged, but" : "The merge was stopped and";
          throw new CoreError("GIT_FAILED", `${action} the main workspace changes could not be restored cleanly. Resolve the working tree conflicts; the backup remains in Git stash. ${gitError(restoreError)}`);
        }
      }
      if (error instanceof CoreError) throw error;
      throw new CoreError("GIT_FAILED", `Could not merge task ${task.name}: ${gitError(error)}`);
    }
  }

  async delete(taskId: string): Promise<Registry> {
    const registry = await this.list();
    const task = registry.tasks.find((item) => item.id === taskId);
    if (!task) throw new CoreError("INVALID_REQUEST", "Task does not exist");
    const next = { tasks: registry.tasks.filter((item) => item.id !== taskId), ...(registry.selectedTaskId && registry.selectedTaskId !== taskId ? { selectedTaskId: registry.selectedTaskId } : {}) };
    try {
      await this.removeWorktree(this.taskPath(taskId));
      if (await this.branchExists(task.branch)) await execFileAsync("git", ["-C", this.rootWorkspace, "branch", "-D", task.branch], { encoding: "utf8" });
      await rm(path.dirname(this.taskPath(taskId)), { recursive: true, force: true });
      await rm(path.join(this.stateDirectory, `${crypto.createHash("sha256").update(path.resolve(this.taskPath(taskId))).digest("hex")}-task-history`), { recursive: true, force: true });
      await this.save(next);
      return next;
    } catch (error) {
      throw new CoreError("GIT_FAILED", `Could not delete task worktree: ${gitError(error)}`);
    }
  }

  taskPath(taskId: string): string { return path.join(this.directory, taskId, "workspace"); }

  private async migrateLegacyCopy(task: WorkspaceTask): Promise<void> {
    const destination = this.taskPath(task.id);
    let gitMetadata;
    try { gitMetadata = await lstat(path.join(destination, ".git")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!gitMetadata.isDirectory()) return;

    const migrationRef = `refs/vibe-editor/migration/${task.id}`;
    const backup = path.join(path.dirname(destination), `legacy-workspace-${process.pid}`);
    let createdBranch = false;
    try {
      await execFileAsync("git", ["-C", this.rootWorkspace, "fetch", "--no-tags", destination, `${task.branch}:${migrationRef}`], { encoding: "utf8" });
      const migratedCommit = (await execFileAsync("git", ["-C", this.rootWorkspace, "rev-parse", migrationRef], { encoding: "utf8" })).stdout.trim();
      if (await this.branchExists(task.branch)) {
        const existingCommit = (await execFileAsync("git", ["-C", this.rootWorkspace, "rev-parse", task.branch], { encoding: "utf8" })).stdout.trim();
        if (existingCommit !== migratedCommit) throw new Error(`Git branch ${task.branch} already exists at a different commit`);
      } else {
        await execFileAsync("git", ["-C", this.rootWorkspace, "branch", task.branch, migratedCommit], { encoding: "utf8" });
        createdBranch = true;
      }
      await rename(destination, backup);
      await execFileAsync("git", ["-C", this.rootWorkspace, "worktree", "add", destination, task.branch], { encoding: "utf8" });
      await this.copyWorkspaceState(backup, destination);
      await rm(backup, { recursive: true, force: true });
      await execFileAsync("git", ["-C", this.rootWorkspace, "update-ref", "-d", migrationRef], { encoding: "utf8" });
    } catch (error) {
      if (await exists(backup)) {
        await this.removeWorktree(destination);
        await rm(destination, { recursive: true, force: true });
        await rename(backup, destination).catch(() => undefined);
      }
      if (createdBranch && await this.branchExists(task.branch)) await execFileAsync("git", ["-C", this.rootWorkspace, "branch", "-D", task.branch], { encoding: "utf8" }).catch(() => undefined);
      await execFileAsync("git", ["-C", this.rootWorkspace, "update-ref", "-d", migrationRef], { encoding: "utf8" }).catch(() => undefined);
      throw new CoreError("GIT_FAILED", `Could not migrate task ${task.name} to a Git worktree: ${gitError(error)}`);
    }
  }

  private async copyWorkspaceState(source: string, destination: string): Promise<void> {
    const stagedPatch = (await execFileAsync("git", ["-C", source, "diff", "--cached", "--binary"], { encoding: "buffer", maxBuffer: 100 * 1024 * 1024 })).stdout;
    const deleted = (await execFileAsync("git", ["-C", source, "ls-files", "--deleted", "-z"], { encoding: "utf8" })).stdout.split("\0").filter(Boolean);
    await cp(source, destination, { recursive: true, force: true, filter: (item) => item !== path.join(source, ".git") && !isNodeModulesPath(source, item) });
    for (const relative of deleted) await rm(path.join(destination, relative), { recursive: true, force: true });
    if (!stagedPatch.length) return;
    const patchFile = path.join(path.dirname(destination), `staged-${process.pid}-${crypto.randomUUID()}.patch`);
    await writeFile(patchFile, stagedPatch);
    try { await execFileAsync("git", ["-C", destination, "apply", "--cached", "--binary", patchFile], { maxBuffer: 100 * 1024 * 1024 }); }
    finally { await rm(patchFile, { force: true }); }
  }

  private async branchExists(branch: string): Promise<boolean> {
    try { await execFileAsync("git", ["-C", this.rootWorkspace, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); return true; }
    catch { return false; }
  }

  private async removeSharedNodeModules(workspace: string): Promise<void> {
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const target = path.join(directory, entry.name);
        if (entry.name === "node_modules") {
          if (entry.isSymbolicLink()) {
            const linkTarget = path.resolve(path.dirname(target), await readlink(target));
            const formerSharedTarget = path.join(this.rootWorkspace, path.relative(workspace, target));
            if (linkTarget === formerSharedTarget) await rm(target);
          }
          continue;
        }
        if (entry.isDirectory()) await walk(target);
      }
    };
    await walk(workspace);
  }

  private async removeWorktree(workspace: string): Promise<void> {
    await execFileAsync("git", ["-C", this.rootWorkspace, "worktree", "remove", "--force", workspace], { encoding: "utf8" }).catch(() => undefined);
    await execFileAsync("git", ["-C", this.rootWorkspace, "worktree", "prune"], { encoding: "utf8" }).catch(() => undefined);
  }

  private async rootBranch(): Promise<string> {
    try {
      return (await execFileAsync("git", ["-C", this.rootWorkspace, "branch", "--show-current"], { encoding: "utf8" })).stdout.trim() || "HEAD";
    }
    catch (error) { throw new CoreError("GIT_FAILED", `Could not determine task base branch: ${gitError(error)}`); }
  }

  private async configureNewBranchPush(branch: string): Promise<void> {
    if (branch === "HEAD") return;
    let remote: string;
    try {
      remote = (await execFileAsync("git", ["-C", this.rootWorkspace, "config", "--get", `branch.${await this.rootBranch()}.remote`], { encoding: "utf8" })).stdout.trim();
    } catch {
      return;
    }
    if (!remote || remote === ".") return;
    await execFileAsync("git", ["-C", this.rootWorkspace, "config", `branch.${branch}.remote`, remote], { encoding: "utf8" });
    await execFileAsync("git", ["-C", this.rootWorkspace, "config", `branch.${branch}.merge`, `refs/heads/${branch}`], { encoding: "utf8" });
  }

  private async save(registry: Registry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.registryFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary, this.registryFile);
  }
}

function isNodeModulesPath(root: string, source: string): boolean {
  return path.relative(root, source).split(path.sep).includes("node_modules");
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function gitError(error: unknown): string {
  const detail = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  return String(detail.stderr || detail.stdout || detail.message || error).trim();
}

async function gitRefExists(workspace: string, ref: string): Promise<boolean> {
  try { await execFileAsync("git", ["-C", workspace, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }); return true; }
  catch { return false; }
}

function validateCommitMessage(message: string): void {
  if (typeof message !== "string" || !message.trim()) throw new CoreError("INVALID_REQUEST", "Commit message must contain at least one non-whitespace character");
  if (message.length > 10_000) throw new CoreError("INVALID_REQUEST", "Commit message must be at most 10000 characters");
  if (message.includes("\0")) throw new CoreError("INVALID_REQUEST", "Commit message must not contain NUL characters");
}

function isTask(value: unknown): value is WorkspaceTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && typeof task.name === "string" && typeof task.branch === "string" && (task.baseBranch === undefined || typeof task.baseBranch === "string");
}
