import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { ScheduleInput, WorkspaceSchedule } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { serializedStateMutation } from "./root-mutation.js";

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

type PendingLaunch = { id: string; pid: number; host: string; startedAt: string };
type StoredSchedule = WorkspaceSchedule & { pendingLaunch?: PendingLaunch };
type ScheduleFile = { schedules: StoredSchedule[] };
const UNKNOWN_LAUNCH = "Core stopped while this schedule was launching. Check for started work before retrying.";
function abandoned(launch: PendingLaunch): boolean {
  if (launch.host !== os.hostname()) return false;
  try { process.kill(launch.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function withoutLaunch(schedule: StoredSchedule): WorkspaceSchedule { const { pendingLaunch: _pendingLaunch, ...value } = schedule; return value; }
function interrupted(schedule: StoredSchedule): WorkspaceSchedule { return { ...withoutLaunch(schedule), enabled: false, lastError: UNKNOWN_LAUNCH }; }
function publicSchedule(schedule: StoredSchedule): WorkspaceSchedule {
  if (schedule.pendingLaunch?.host !== undefined && schedule.pendingLaunch.host !== os.hostname()) return { ...withoutLaunch(schedule), enabled: false, lastError: "A scheduled launch is owned by another host. Inspect its outcome before retrying." };
  return schedule.pendingLaunch && abandoned(schedule.pendingLaunch) ? interrupted(schedule) : withoutLaunch(schedule);
}


/** Durable user schedules are separate from agent-owned continuation timers. */
export class ScheduleService {
  private readonly file: string;
  private schedules: StoredSchedule[] = [];
  private readonly handles = new Map<string, NodeJS.Timeout>();
  private readonly cancellationEpochs = new Map<string, number>();
  private readonly running = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly pendingFires = new Set<Promise<boolean>>();
  private closePromise?: Promise<void>;
  private warnedBackupRecovery = false;

  constructor(rootWorkspace: string, private readonly deliver: (schedule: WorkspaceSchedule, active: () => boolean) => Promise<{ workflowRunId?: string }>, private readonly changed: () => void, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    this.file = path.join(stateDirectory, `${crypto.createHash("sha256").update(rootWorkspace).digest("hex")}-schedules.json`);
  }

  async start(): Promise<void> {
    this.assertOpen();
    this.schedules = await this.readStoredSchedules();
    if (this.schedules.some((schedule) => schedule.pendingLaunch && abandoned(schedule.pendingLaunch))) {
      await this.mutate((items) => items.map((schedule) => schedule.pendingLaunch && abandoned(schedule.pendingLaunch) ? interrupted(schedule) : schedule));
    }
    for (const schedule of this.schedules) this.arm(schedule);
  }

  private async readStoredSchedules(): Promise<StoredSchedule[]> {
    let primary: StoredSchedule[] | undefined;
    let primaryError: string | undefined;
    try { primary = await this.readValidFile(this.file); }
    catch (error) { primaryError = error instanceof Error ? error.message : String(error); }
    if (primary) { this.warnedBackupRecovery = false; return primary; }

    let backup: StoredSchedule[] | undefined;
    let backupError: string | undefined;
    try { backup = await this.readValidFile(`${this.file}.bak`); }
    catch (error) { backupError = error instanceof Error ? error.message : String(error); }
    if (backup) {
      if (!this.warnedBackupRecovery) {
        console.warn(`[core] Recovered schedules from last-good backup ${this.file}.bak${primaryError ? ` (primary: ${primaryError})` : " (primary is missing)"}`);
        this.warnedBackupRecovery = true;
      }
      return backup;
    }
    if (!primaryError && !backupError) return [];
    throw new CoreError("READ_FAILED", `Could not read schedule state (${[primaryError, backupError].filter(Boolean).join("; backup: ")})`);
  }

  private async readValidFile(file: string): Promise<StoredSchedule[] | undefined> {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state must be a JSON object");
      const schedules = (value as Partial<ScheduleFile>).schedules;
      if (!Array.isArray(schedules)) throw new Error("schedules must be an array");
      this.validateStoredSchedules(schedules);
      return schedules;
    } catch (error) {
      throw new Error(`Invalid schedule state in ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private validateStoredSchedules(schedules: unknown): asserts schedules is StoredSchedule[] {
    if (!Array.isArray(schedules)) throw new Error("schedules must be an array");
    const identities = new Set<string>();
    for (const schedule of schedules) {
      if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) throw new Error("schedule record must be an object");
      validateSchedule(schedule as ScheduleInput);
      if (typeof schedule.id !== "string" || typeof schedule.rootId !== "string" || typeof schedule.enabled !== "boolean") throw new Error("saved schedule id, rootId, or enabled field is invalid");
      if (!schedule.id.trim() || !schedule.rootId.trim() || identities.has(schedule.id)) throw new Error("schedule identities must be nonempty and unique");
      identities.add(schedule.id);
      const launch = schedule.pendingLaunch;
      if (launch !== undefined && (!launch || typeof launch !== "object" || typeof launch.id !== "string" || !Number.isSafeInteger(launch.pid) || launch.pid <= 0 || typeof launch.host !== "string" || typeof launch.startedAt !== "string" || !Number.isFinite(Date.parse(launch.startedAt)))) throw new Error("saved launch ownership is invalid");
    }
  }

  list(): WorkspaceSchedule[] { return this.schedules.map((schedule) => structuredClone(publicSchedule(schedule))).sort((a, b) => a.dueAt.localeCompare(b.dueAt)); }

  async create(rootId: string, input: ScheduleInput): Promise<WorkspaceSchedule> {
    this.assertOpen();
    if (typeof rootId !== "string" || !rootId.trim()) throw new CoreError("INVALID_REQUEST", "Schedule root must be a nonempty ID");
    validateSchedule(input);
    if (Date.parse(input.dueAt) <= Date.now()) throw new CoreError("INVALID_REQUEST", "First run time must be in the future");
    const schedule = { ...structuredClone(input), name: input.name.trim(), dueAt: new Date(input.dueAt).toISOString(), id: crypto.randomUUID(), rootId, enabled: true, createdAt: new Date().toISOString() };
    await this.mutate((items) => [...items, schedule]);
    this.arm(schedule);
    return schedule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<WorkspaceSchedule> {
    this.assertOpen();
    if (typeof enabled !== "boolean") throw new CoreError("INVALID_REQUEST", "Enabled must be a boolean");
    if (!enabled) this.cancellationEpochs.set(id, (this.cancellationEpochs.get(id) ?? 0) + 1);
    await this.mutate((items) => items.map((item) => {
      if (item.id !== id) return item;
      if (enabled && item.pendingLaunch && !abandoned(item.pendingLaunch)) throw new CoreError("INVALID_REQUEST", "This schedule is already launching in a Core process; wait for it to finish");
      return { ...(enabled ? withoutLaunch(item) : item), enabled, lastError: undefined };
    }));
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule) throw new CoreError("FILE_NOT_FOUND", "Schedule no longer exists");
    this.disarm(id); this.arm(schedule);
    return structuredClone(withoutLaunch(schedule));
  }

  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    this.cancellationEpochs.set(id, (this.cancellationEpochs.get(id) ?? 0) + 1);
    let exists = false;
    await this.mutate((items) => { exists = items.some((item) => item.id === id); return items.filter((item) => item.id !== id); });
    this.disarm(id);
    return exists;
  }

  fire(id: string, immediately = false): Promise<boolean> {
    const pending = this.fireNow(id, immediately);
    this.pendingFires.add(pending);
    void pending.finally(() => this.pendingFires.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async fireNow(id: string, immediately: boolean): Promise<boolean> {
    if (this.closed || this.running.has(id)) return false;
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule || (!immediately && !schedule.enabled)) return false;
    if (!immediately && Date.parse(schedule.dueAt) > Date.now()) { this.arm(schedule); return false; }
    const epoch = this.cancellationEpochs.get(id) ?? 0;
    const active = () => !this.closed && (this.cancellationEpochs.get(id) ?? 0) === epoch && this.schedules.some((item) => item.id === id);
    this.running.add(id); this.disarm(id);
    const occurrenceId = crypto.randomUUID();
    let rearmAllowed = true;
    try {
      // Persist the claim before starting an external action: restart never replays a claimed one-time run.
      const now = new Date().toISOString();
      let claimed = false;
      await this.mutate((items) => items.map((item) => {
        if (item.id === id && item.pendingLaunch) return abandoned(item.pendingLaunch) ? interrupted(item) : item;
        if (item.id !== id || (!immediately && (!item.enabled || Date.parse(item.dueAt) > Date.now()))) return item;
        claimed = true;
        return { ...item, pendingLaunch: { id: occurrenceId, pid: process.pid, host: os.hostname(), startedAt: now }, lastRunAt: now, lastError: undefined, enabled: Boolean(item.intervalSeconds) && item.enabled, ...(item.intervalSeconds ? { dueAt: new Date(Date.now() + item.intervalSeconds * 1000).toISOString() } : {}) };
      }));
      if (!claimed) return false;
      // A pause/delete that won the write queue prevents delivery.
      const current = this.schedules.find((item) => item.id === id);
      if (!current || !active() || (schedule.intervalSeconds && schedule.enabled && !current.enabled)) {
        await this.mutate((items) => items.map((item) => item.id === id && item.pendingLaunch?.id === occurrenceId ? withoutLaunch(item) : item));
        return false;
      }
      const result = await this.deliver(structuredClone(withoutLaunch(schedule)), active);
      await this.mutate((items) => items.map((item) => item.id === id && item.pendingLaunch?.id === occurrenceId ? { ...withoutLaunch(item), ...(result.workflowRunId ? { lastWorkflowRunId: result.workflowRunId } : {}) } : item));
      return true;
    } catch (error) {
      // If state cannot be read or written, do not repeatedly re-arm a cached
      // due record. A later explicit action can retry after storage is repaired.
      rearmAllowed = false;
      await this.mutate((items) => items.map((item) => item.id === id && item.pendingLaunch?.id === occurrenceId ? { ...withoutLaunch(item), enabled: false, lastError: error instanceof Error ? error.message : String(error) } : item));
      rearmAllowed = true;
      return false;
    } finally {
      this.running.delete(id);
      const current = this.schedules.find((item) => item.id === id);
      if (rearmAllowed && current?.enabled && !current.pendingLaunch && current.intervalSeconds && Date.parse(current.dueAt) <= Date.now()) {
        const dueAt = new Date(Date.now() + current.intervalSeconds * 1000).toISOString();
        await this.mutate((items) => items.map((item) => item.id === id ? { ...item, dueAt } : item));
      }
      const next = this.schedules.find((item) => item.id === id);
      if (rearmAllowed && next) this.arm(next);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    for (const id of this.handles.keys()) this.disarm(id);
    return this.closePromise ??= (async () => {
      const deliveries = await Promise.allSettled([...this.pendingFires]);
      const writes = await Promise.allSettled([this.writes]);
      const failures = [...deliveries, ...writes].filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Scheduled work could not be drained");
    })();
  }

  private assertOpen(): void { if (this.closed) throw new CoreError("INVALID_REQUEST", "Schedules are shutting down"); }

  private arm(schedule: StoredSchedule): void {
    if (this.closed || !schedule.enabled || this.running.has(schedule.id) || (schedule.pendingLaunch && schedule.pendingLaunch.host !== os.hostname())) return;
    this.disarm(schedule.id);
    const delay = Math.max(schedule.pendingLaunch ? 1_000 : 0, Date.parse(schedule.dueAt) - Date.now());
    const handle = setTimeout(() => { void this.fire(schedule.id).catch((error) => console.error("[core] schedule failed", error)); }, Math.min(delay, 2_147_483_647));
    handle.unref(); this.handles.set(schedule.id, handle);
  }
  private disarm(id: string): void { const handle = this.handles.get(id); if (handle) clearTimeout(handle); this.handles.delete(id); }

  private async mutate(update: (items: StoredSchedule[]) => StoredSchedule[]): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      await serializedStateMutation(this.file, async () => {
        const previous = await this.readStoredSchedules();
        const items = update(previous);
        this.validateStoredSchedules(items);
        await mkdir(path.dirname(this.file), { recursive: true });
        await this.atomicWrite(`${this.file}.bak`, previous);
        await this.atomicWrite(this.file, items);
        this.schedules = items;
        this.changed();
      });
    });
    this.writes = write;
    await write;
  }

  private async atomicWrite(file: string, schedules: WorkspaceSchedule[]): Promise<void> {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ schedules }, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
