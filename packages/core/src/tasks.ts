import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { cp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoreError } from "./errors.js";

const execFileAsync = promisify(execFile);
export type WorkspaceTask = { id: string; name: string; branch: string; baseBranch: string };
type Registry = { selectedTaskId?: string; tasks: WorkspaceTask[] };

export class WorkspaceTaskStore {
  private readonly directory: string;
  private readonly registryFile: string;

  constructor(private readonly rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
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
      return { tasks, ...(value.selectedTaskId && tasks.some((task) => task.id === value.selectedTaskId) ? { selectedTaskId: value.selectedTaskId } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: [] };
      throw new CoreError("READ_FAILED", `Could not read tasks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async create(branch: string): Promise<WorkspaceTask> {
    const name = branch.trim();
    if (!name || name.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes("..") || name.endsWith("/") || name.endsWith(".")) throw new CoreError("INVALID_REQUEST", "Invalid Git branch name");
    const registry = await this.list();
    if (registry.tasks.some((task) => task.branch === name)) throw new CoreError("INVALID_REQUEST", `A task already uses branch ${name}`);
    const task: WorkspaceTask = { id: crypto.randomUUID(), name, branch: name, baseBranch: await this.rootBranch() };
    const destination = this.taskPath(task.id);
    try {
      const nodeModulesDirs = await findNodeModulesDirs(this.rootWorkspace);
      const skip = new Set(nodeModulesDirs);
      await mkdir(path.dirname(destination), { recursive: true });
      // node_modules is excluded from the copy and symlinked back to the root workspace instead: task
      // branches share the same dependency tree as root, so duplicating potentially huge install trees
      // per task wastes disk and time. If a task needs its own deps (e.g. after `npm install`), the
      // symlink can be replaced there without affecting root or other tasks.
      await cp(this.rootWorkspace, destination, { recursive: true, errorOnExist: true, force: false, filter: (source) => !skip.has(source) });
      for (const source of nodeModulesDirs) {
        await symlink(source, path.join(destination, path.relative(this.rootWorkspace, source)), "dir");
      }
      await execFileAsync("git", ["-C", destination, "switch", "-C", name], { encoding: "utf8" });
      if (task.baseBranch !== "HEAD") await execFileAsync("git", ["-C", destination, "branch", "--set-upstream-to", task.baseBranch, name], { encoding: "utf8" });
      await this.save({ tasks: [...registry.tasks, task], selectedTaskId: task.id });
      return task;
    } catch (error) {
      throw new CoreError("GIT_FAILED", `Could not create task workspace: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async select(taskId?: string): Promise<{ workspace: string; registry: Registry }> {
    const registry = await this.list();
    if (taskId && !registry.tasks.some((task) => task.id === taskId)) throw new CoreError("INVALID_REQUEST", "Task does not exist");
    const next = { tasks: registry.tasks, ...(taskId ? { selectedTaskId: taskId } : {}) };
    await this.save(next);
    return { workspace: taskId ? this.taskPath(taskId) : this.rootWorkspace, registry: next };
  }

  async merge(taskId: string): Promise<{ targetBranch: string }> {
    const registry = await this.list();
    const task = registry.tasks.find((item) => item.id === taskId);
    if (!task) throw new CoreError("INVALID_REQUEST", "Task does not exist");
    const taskWorkspace = this.taskPath(taskId);
    try {
      const [rootStatus, taskStatus, targetBranch] = await Promise.all([
        execFileAsync("git", ["-C", this.rootWorkspace, "status", "--porcelain"], { encoding: "utf8" }),
        execFileAsync("git", ["-C", taskWorkspace, "status", "--porcelain"], { encoding: "utf8" }),
        execFileAsync("git", ["-C", this.rootWorkspace, "branch", "--show-current"], { encoding: "utf8" }),
      ]);
      if (rootStatus.stdout.trim()) throw new CoreError("GIT_FAILED", "Main workspace has uncommitted changes. Commit or rollback them before merging a task.");
      if (taskStatus.stdout.trim()) throw new CoreError("GIT_FAILED", `Task ${task.name} has uncommitted changes. Commit them before merging.`);
      const branch = targetBranch.stdout.trim();
      if (!branch) throw new CoreError("GIT_FAILED", "Main workspace is in detached HEAD state. Check out a branch before merging.");
      await execFileAsync("git", ["-C", this.rootWorkspace, "fetch", "--no-tags", taskWorkspace, task.branch], { encoding: "utf8" });
      try { await execFileAsync("git", ["-C", this.rootWorkspace, "merge", "--no-edit", "FETCH_HEAD"], { encoding: "utf8" }); }
      catch (mergeError) {
        await execFileAsync("git", ["-C", this.rootWorkspace, "merge", "--abort"], { encoding: "utf8" }).catch(() => undefined);
        throw mergeError;
      }
      return { targetBranch: branch };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      const detail = error as { stderr?: string; stdout?: string; message?: string };
      throw new CoreError("GIT_FAILED", `Could not merge task ${task.name}: ${(detail.stderr || detail.stdout || detail.message || String(error)).trim()}`);
    }
  }

  async delete(taskId: string): Promise<Registry> {
    const registry = await this.list();
    if (!registry.tasks.some((task) => task.id === taskId)) throw new CoreError("INVALID_REQUEST", "Task does not exist");
    const next = { tasks: registry.tasks.filter((task) => task.id !== taskId), ...(registry.selectedTaskId && registry.selectedTaskId !== taskId ? { selectedTaskId: registry.selectedTaskId } : {}) };
    await rm(path.dirname(this.taskPath(taskId)), { recursive: true, force: true });
    await this.save(next);
    return next;
  }

  taskPath(taskId: string): string { return path.join(this.directory, taskId, "workspace"); }

  private async rootBranch(): Promise<string> {
    try {
      try {
        const upstream = (await execFileAsync("git", ["-C", this.rootWorkspace, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { encoding: "utf8" })).stdout.trim();
        if (upstream) return upstream;
      } catch { /* A local-only branch uses its current branch as the task base. */ }
      return (await execFileAsync("git", ["-C", this.rootWorkspace, "branch", "--show-current"], { encoding: "utf8" })).stdout.trim() || "HEAD";
    }
    catch (error) { throw new CoreError("GIT_FAILED", `Could not determine task base branch: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async save(registry: Registry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.registryFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary, this.registryFile);
  }
}

// Finds every top-level `node_modules` directory under `root` (i.e. root's own and each
// workspace package's), without descending into `.git` or into `node_modules` itself.
async function findNodeModulesDirs(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "node_modules") { results.push(full); continue; }
      await walk(full);
    }
  };
  await walk(root);
  return results;
}

function isTask(value: unknown): value is WorkspaceTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && typeof task.name === "string" && typeof task.branch === "string" && (task.baseBranch === undefined || typeof task.baseBranch === "string");
}
