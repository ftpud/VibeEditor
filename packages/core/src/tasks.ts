import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoreError } from "./errors.js";

const execFileAsync = promisify(execFile);
export type WorkspaceTask = { id: string; name: string; branch: string };
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
      return { tasks: value.tasks.filter(isTask), ...(value.selectedTaskId && value.tasks.some((task) => task.id === value.selectedTaskId) ? { selectedTaskId: value.selectedTaskId } : {}) };
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
    const task: WorkspaceTask = { id: crypto.randomUUID(), name, branch: name };
    const destination = this.taskPath(task.id);
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(this.rootWorkspace, destination, { recursive: true, errorOnExist: true, force: false });
      await execFileAsync("git", ["-C", destination, "switch", "-C", name], { encoding: "utf8" });
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

  taskPath(taskId: string): string { return path.join(this.directory, taskId, "workspace"); }

  private async save(registry: Registry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.registryFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary, this.registryFile);
  }
}

function isTask(value: unknown): value is WorkspaceTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && typeof task.name === "string" && typeof task.branch === "string";
}
