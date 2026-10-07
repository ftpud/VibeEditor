import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ScheduleInput, WorkspaceSchedule } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

export function validateSchedule(input: ScheduleInput): void {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 180) throw new CoreError("INVALID_REQUEST", "A schedule needs a name of at most 180 characters");
  if (typeof input.dueAt !== "string" || !Number.isFinite(Date.parse(input.dueAt))) throw new CoreError("INVALID_REQUEST", "Choose a valid first run time");
  if (input.intervalSeconds !== undefined && (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60 || input.intervalSeconds > 31_536_000)) throw new CoreError("INVALID_REQUEST", "Repeat intervals must be between 60 seconds and one year");
  if (input.taskId !== undefined && (typeof input.taskId !== "string" || !input.taskId)) throw new CoreError("INVALID_REQUEST", "Choose a valid task");
  const action = input.action;
  if (!action || typeof action.provider !== "string" || !action.provider || !["prompt", "workflow"].includes(action.type)) throw new CoreError("INVALID_REQUEST", "Choose a schedule action and provider");
  if (action.type === "prompt" && (typeof action.prompt !== "string" || !action.prompt.trim())) throw new CoreError("INVALID_REQUEST", "Enter a prompt");
  if (action.type === "prompt" && action.agent && (typeof action.agent.name !== "string" || !["global", "local", "workspace"].includes(action.agent.scope))) throw new CoreError("INVALID_REQUEST", "Choose a valid agent preset");
  if (action.type === "workflow" && (typeof action.harnessId !== "string" || !action.harnessId || typeof action.input !== "string")) throw new CoreError("INVALID_REQUEST", "Choose a workflow and its input");
}

/** Durable user schedules are separate from agent-owned continuation timers. */
export class ScheduleService {
  private readonly file: string;
  private schedules: WorkspaceSchedule[] = [];
  private readonly handles = new Map<string, NodeJS.Timeout>();
  private readonly cancellationEpochs = new Map<string, number>();
  private readonly running = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(rootWorkspace: string, private readonly deliver: (schedule: WorkspaceSchedule, active: () => boolean) => Promise<{ workflowRunId?: string }>, private readonly changed: () => void, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    this.file = path.join(stateDirectory, `${crypto.createHash("sha256").update(rootWorkspace).digest("hex")}-schedules.json`);
  }

  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as { schedules: WorkspaceSchedule[] };
      if (!Array.isArray(saved.schedules)) throw new Error("Invalid schedule state");
      for (const schedule of saved.schedules) {
        validateSchedule(schedule);
        if (typeof schedule.id !== "string" || typeof schedule.rootId !== "string" || typeof schedule.enabled !== "boolean") throw new Error("Invalid saved schedule");
      }
      this.schedules = saved.schedules;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const schedule of this.schedules) this.arm(schedule);
  }

  list(): WorkspaceSchedule[] { return structuredClone(this.schedules).sort((a, b) => a.dueAt.localeCompare(b.dueAt)); }

  async create(rootId: string, input: ScheduleInput): Promise<WorkspaceSchedule> {
    validateSchedule(input);
    if (Date.parse(input.dueAt) <= Date.now()) throw new CoreError("INVALID_REQUEST", "First run time must be in the future");
    const schedule = { ...structuredClone(input), name: input.name.trim(), dueAt: new Date(input.dueAt).toISOString(), id: crypto.randomUUID(), rootId, enabled: true, createdAt: new Date().toISOString() };
    await this.mutate((items) => [...items, schedule]);
    this.arm(schedule);
    return schedule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<WorkspaceSchedule> {
    if (typeof enabled !== "boolean") throw new CoreError("INVALID_REQUEST", "Enabled must be a boolean");
    if (!enabled) this.cancellationEpochs.set(id, (this.cancellationEpochs.get(id) ?? 0) + 1);
    await this.mutate((items) => items.map((item) => item.id === id ? { ...item, enabled, lastError: undefined } : item));
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule) throw new CoreError("FILE_NOT_FOUND", "Schedule no longer exists");
    this.disarm(id); this.arm(schedule);
    return structuredClone(schedule);
  }

  async delete(id: string): Promise<boolean> {
    this.cancellationEpochs.set(id, (this.cancellationEpochs.get(id) ?? 0) + 1);
    const exists = this.schedules.some((item) => item.id === id);
    await this.mutate((items) => items.filter((item) => item.id !== id));
    this.disarm(id);
    return exists;
  }

  async fire(id: string, immediately = false): Promise<boolean> {
    if (this.closed || this.running.has(id)) return false;
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule || (!immediately && !schedule.enabled)) return false;
    if (!immediately && Date.parse(schedule.dueAt) > Date.now()) { this.arm(schedule); return false; }
    const epoch = this.cancellationEpochs.get(id) ?? 0;
    const active = () => !this.closed && (this.cancellationEpochs.get(id) ?? 0) === epoch && this.schedules.some((item) => item.id === id);
    this.running.add(id); this.disarm(id);
    try {
      // Persist the claim before starting an external action: restart never replays a claimed one-time run.
      const now = new Date().toISOString();
      await this.mutate((items) => items.map((item) => item.id === id ? { ...item, lastRunAt: now, lastError: undefined, enabled: Boolean(item.intervalSeconds) && item.enabled, ...(item.intervalSeconds ? { dueAt: new Date(Date.now() + item.intervalSeconds * 1000).toISOString() } : {}) } : item));
      // A pause/delete that won the write queue prevents delivery.
      const current = this.schedules.find((item) => item.id === id);
      if (!current || !active() || (schedule.intervalSeconds && schedule.enabled && !current.enabled)) return false;
      const result = await this.deliver(structuredClone(schedule), active);
      await this.mutate((items) => items.map((item) => item.id === id ? { ...item, ...(result.workflowRunId ? { lastWorkflowRunId: result.workflowRunId } : {}) } : item));
      return true;
    } catch (error) {
      await this.mutate((items) => items.map((item) => item.id === id ? { ...item, enabled: false, lastError: error instanceof Error ? error.message : String(error) } : item));
      return false;
    } finally {
      this.running.delete(id);
      const current = this.schedules.find((item) => item.id === id);
      if (current?.enabled && current.intervalSeconds && Date.parse(current.dueAt) <= Date.now()) {
        const dueAt = new Date(Date.now() + current.intervalSeconds * 1000).toISOString();
        await this.mutate((items) => items.map((item) => item.id === id ? { ...item, dueAt } : item));
      }
      const next = this.schedules.find((item) => item.id === id);
      if (next) this.arm(next);
    }
  }

  close(): void { this.closed = true; for (const id of this.handles.keys()) this.disarm(id); }

  private arm(schedule: WorkspaceSchedule): void {
    if (this.closed || !schedule.enabled || this.running.has(schedule.id)) return;
    this.disarm(schedule.id);
    const delay = Math.max(0, Date.parse(schedule.dueAt) - Date.now());
    const handle = setTimeout(() => { void this.fire(schedule.id).catch((error) => console.error("[core] schedule failed", error)); }, Math.min(delay, 2_147_483_647));
    handle.unref(); this.handles.set(schedule.id, handle);
  }
  private disarm(id: string): void { const handle = this.handles.get(id); if (handle) clearTimeout(handle); this.handles.delete(id); }

  private async mutate(update: (items: WorkspaceSchedule[]) => WorkspaceSchedule[]): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      const items = update(this.schedules);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ schedules: items }, null, 2)}\n`, "utf8");
      await rename(temporary, this.file);
      this.schedules = items;
      this.changed();
    });
    this.writes = write;
    await write;
  }
}
