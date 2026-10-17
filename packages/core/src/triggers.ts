import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, openSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TriggerFileEvent, TriggerInput, WorkspaceTrigger } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";
import { serializedStateMutation } from "./root-mutation.js";
import { validateScheduledAction } from "./schedules.js";

const execFileAsync = promisify(execFile);
const FILE_EVENTS: readonly TriggerFileEvent[] = ["created", "changed", "deleted"];
const DEFAULT_DEBOUNCE_SECONDS = 2;
const DEFAULT_MAX_FIRES_PER_HOUR = 20;
const MAX_EVENT_DATA = 8_000;
const POLL_INTERVAL_MS = 1_000;

export type TriggerEvent = { description: string; data?: string };
/** `skipped` means the target was busy: nothing was started and the trigger stays armed. */
export type TriggerDelivery = { workflowRunId?: string; skipped?: string };

export function validateTrigger(input: TriggerInput): void {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 180) throw new CoreError("INVALID_REQUEST", "A trigger needs a name of at most 180 characters");
  const source = input.source;
  if (!source || !["file", "fifo"].includes(source.type)) throw new CoreError("INVALID_REQUEST", "Choose a file or pipe to watch");
  if (typeof source.path !== "string" || !source.path.trim() || source.path.length > 4096 || source.path.includes("\0")) throw new CoreError("INVALID_REQUEST", "Enter the path to watch");
  if (source.type === "file" && (!Array.isArray(source.events) || !source.events.length || source.events.some((event) => !FILE_EVENTS.includes(event)))) throw new CoreError("INVALID_REQUEST", "Choose at least one file event");
  if (input.taskId !== undefined && (typeof input.taskId !== "string" || !input.taskId)) throw new CoreError("INVALID_REQUEST", "Choose a valid task");
  if (input.debounceSeconds !== undefined && (!Number.isInteger(input.debounceSeconds) || input.debounceSeconds < 0 || input.debounceSeconds > 3600)) throw new CoreError("INVALID_REQUEST", "Quiet period must be between 0 and 3600 seconds");
  if (input.maxFiresPerHour !== undefined && (!Number.isInteger(input.maxFiresPerHour) || input.maxFiresPerHour < 1 || input.maxFiresPerHour > 1000)) throw new CoreError("INVALID_REQUEST", "Hourly limit must be between 1 and 1000");
  validateScheduledAction(input.action);
}

type TriggerFile = { triggers: WorkspaceTrigger[] };

/**
 * Reactive counterpart of the schedule service: instead of a due time, a trigger fires when a watched
 * file changes or when data arrives on a named pipe. Quiet-period debouncing, a no-overlap rule and an
 * hourly fire cap keep an agent that edits the file it is triggered by from looping forever.
 */
export class TriggerService {
  private readonly file: string;
  private triggers: WorkspaceTrigger[] = [];
  private readonly disarmers = new Map<string, () => void>();
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; event: TriggerEvent }>();
  private readonly running = new Set<string>();
  private readonly fireTimes = new Map<string, number[]>();
  private readonly epochs = new Map<string, number>();
  private readonly pendingFires = new Set<Promise<boolean>>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(rootWorkspace: string, private readonly deliver: (trigger: WorkspaceTrigger, event: TriggerEvent, active: () => boolean) => Promise<TriggerDelivery>, private readonly changed: () => void, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide")) {
    this.file = path.join(stateDirectory, `${crypto.createHash("sha256").update(rootWorkspace).digest("hex")}-triggers.json`);
  }

  async start(): Promise<void> {
    this.assertOpen();
    this.triggers = await this.read();
    for (const trigger of this.triggers) void this.arm(trigger);
  }

  list(): WorkspaceTrigger[] { return this.triggers.map((trigger) => structuredClone(trigger)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }

  /** `input.source.path` must already be absolute. */
  async create(rootId: string, input: TriggerInput): Promise<WorkspaceTrigger> {
    this.assertOpen();
    if (typeof rootId !== "string" || !rootId.trim()) throw new CoreError("INVALID_REQUEST", "Trigger root must be a nonempty ID");
    validateTrigger(input);
    if (!path.isAbsolute(input.source.path)) throw new CoreError("INVALID_REQUEST", "Trigger paths must be absolute");
    if (input.source.type === "fifo") await ensureFifo(input.source.path);
    const trigger: WorkspaceTrigger = { ...structuredClone(input), name: input.name.trim(), id: crypto.randomUUID(), rootId, enabled: true, createdAt: new Date().toISOString(), fireCount: 0 };
    await this.mutate((items) => [...items, trigger]);
    void this.arm(trigger);
    return structuredClone(trigger);
  }

  /** Replaces a trigger's definition (used by the configuration interface); counters and history are kept. */
  async update(id: string, input: TriggerInput, enabled: boolean): Promise<WorkspaceTrigger> {
    this.assertOpen();
    validateTrigger(input);
    if (!path.isAbsolute(input.source.path)) throw new CoreError("INVALID_REQUEST", "Trigger paths must be absolute");
    if (!this.triggers.some((item) => item.id === id)) throw new CoreError("FILE_NOT_FOUND", "Trigger no longer exists");
    if (input.source.type === "fifo") await ensureFifo(input.source.path);
    this.cancel(id);
    await this.mutate((items) => items.map((item) => item.id === id ? { ...structuredClone(input), name: input.name.trim(), id, rootId: item.rootId, createdAt: item.createdAt, fireCount: item.fireCount, enabled, ...(item.lastFiredAt ? { lastFiredAt: item.lastFiredAt } : {}), ...(item.lastEvent ? { lastEvent: item.lastEvent } : {}), ...(item.lastWorkflowRunId ? { lastWorkflowRunId: item.lastWorkflowRunId } : {}) } : item));
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) throw new CoreError("FILE_NOT_FOUND", "Trigger no longer exists");
    void this.arm(trigger);
    return structuredClone(trigger);
  }

  async setEnabled(id: string, enabled: boolean): Promise<WorkspaceTrigger> {
    this.assertOpen();
    if (typeof enabled !== "boolean") throw new CoreError("INVALID_REQUEST", "Enabled must be a boolean");
    this.cancel(id);
    await this.mutate((items) => items.map((item) => item.id === id ? { ...item, enabled, lastError: undefined } : item));
    const trigger = this.triggers.find((item) => item.id === id);
    if (!trigger) throw new CoreError("FILE_NOT_FOUND", "Trigger no longer exists");
    if (enabled && trigger.source.type === "fifo") await ensureFifo(trigger.source.path);
    void this.arm(trigger);
    return structuredClone(trigger);
  }

  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    this.cancel(id);
    let exists = false;
    await this.mutate((items) => { exists = items.some((item) => item.id === id); return items.filter((item) => item.id !== id); });
    this.fireTimes.delete(id);
    return exists;
  }

  /** Runs the action now regardless of the quiet period and hourly cap (used for "Run now"). */
  fire(id: string): Promise<boolean> { return this.track(this.fireNow(id, { description: "manual run" }, true)); }

  close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.disarmers.keys()]) this.cancel(id);
    for (const id of [...this.pending.keys()]) this.cancel(id);
    return (async () => {
      const results = await Promise.allSettled([...this.pendingFires, this.writes]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Trigger work could not be drained");
    })();
  }

  private assertOpen(): void { if (this.closed) throw new CoreError("INVALID_REQUEST", "Triggers are shutting down"); }
  private track(fire: Promise<boolean>): Promise<boolean> {
    this.pendingFires.add(fire);
    void fire.finally(() => this.pendingFires.delete(fire)).catch(() => undefined);
    return fire;
  }

  /** Stops watching and discards any event still waiting out its quiet period. */
  private cancel(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.disarmers.get(id)?.(); this.disarmers.delete(id);
    const waiting = this.pending.get(id);
    if (waiting) clearTimeout(waiting.timer);
    this.pending.delete(id);
  }

  private async arm(trigger: WorkspaceTrigger): Promise<void> {
    if (this.closed || !trigger.enabled) return;
    this.disarmers.get(trigger.id)?.();
    try {
      this.disarmers.set(trigger.id, trigger.source.type === "file" ? this.watchPath(trigger, trigger.source.events) : this.watchPipe(trigger));
    } catch (error) {
      await this.mutate((items) => items.map((item) => item.id === trigger.id ? { ...item, enabled: false, lastError: `Could not watch ${trigger.source.path}: ${error instanceof Error ? error.message : String(error)}` } : item)).catch(() => undefined);
    }
  }

  private watchPath(trigger: WorkspaceTrigger, events: TriggerFileEvent[]): () => void {
    const target = trigger.source.path;
    const exists = (stats: Stats) => stats.nlink > 0 || stats.mtimeMs > 0;
    const listener = (current: Stats, previous: Stats) => {
      const before = exists(previous); const after = exists(current);
      const event: TriggerFileEvent | undefined = !before && after ? "created" : before && !after ? "deleted" : before && after && (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) ? "changed" : undefined;
      if (event && events.includes(event)) this.queue(trigger.id, { description: `${event}: ${target}` });
    };
    watchFile(target, { interval: POLL_INTERVAL_MS, persistent: false }, listener);
    return () => unwatchFile(target, listener);
  }

  /** O_RDWR keeps the pipe open without a writer, so opening never blocks and readers never see EOF between writers. */
  private watchPipe(trigger: WorkspaceTrigger): () => void {
    const fd = openSync(trigger.source.path, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
    const socket = new net.Socket({ fd, readable: true, writable: false });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.queue(trigger.id, { description: `data received on ${trigger.source.path}`, data: chunk }));
    socket.on("error", (error) => {
      this.disarmers.delete(trigger.id);
      void this.mutate((items) => items.map((item) => item.id === trigger.id ? { ...item, enabled: false, lastError: `Pipe ${trigger.source.path} failed: ${error.message}` } : item)).catch(() => undefined);
    });
    return () => socket.destroy();
  }

  private queue(id: string, event: TriggerEvent): void {
    const trigger = this.triggers.find((item) => item.id === id);
    if (this.closed || !trigger?.enabled) return;
    const waiting = this.pending.get(id);
    if (waiting) clearTimeout(waiting.timer);
    const merged: TriggerEvent = { description: event.description, ...(waiting?.event.data || event.data ? { data: `${waiting?.event.data ?? ""}${event.data ?? ""}`.slice(-MAX_EVENT_DATA) } : {}) };
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void this.track(this.fireNow(id, merged, false)).catch((error) => console.error("[core] trigger failed", error));
    }, (trigger.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS) * 1000);
    timer.unref();
    this.pending.set(id, { timer, event: merged });
  }

  private async fireNow(id: string, event: TriggerEvent, manual: boolean): Promise<boolean> {
    const trigger = this.triggers.find((item) => item.id === id);
    if (this.closed || !trigger || (!manual && !trigger.enabled)) return false;
    if (this.running.has(id)) { if (!manual) await this.record(id, { lastSkipped: "Previous run is still being started" }); return false; }
    if (!manual) {
      const now = Date.now(); const limit = trigger.maxFiresPerHour ?? DEFAULT_MAX_FIRES_PER_HOUR;
      const recent = (this.fireTimes.get(id) ?? []).filter((time) => now - time < 3_600_000);
      this.fireTimes.set(id, recent);
      if (recent.length >= limit) {
        this.cancel(id);
        await this.record(id, { enabled: false, lastError: `Disabled: fired ${recent.length} times within an hour (limit ${limit}). Check for a feedback loop, then resume.` });
        return false;
      }
    }
    const epoch = this.epochs.get(id) ?? 0;
    const active = () => !this.closed && (manual || (this.epochs.get(id) ?? 0) === epoch) && this.triggers.some((item) => item.id === id);
    this.running.add(id);
    let result: TriggerDelivery;
    try { result = await this.deliver(structuredClone(trigger), event, active); }
    catch (error) {
      this.running.delete(id);
      await this.record(id, { lastError: error instanceof Error ? error.message : String(error), lastSkipped: undefined });
      return false;
    }
    // Release before bookkeeping so an event arriving while state is saved is not mistaken for an overlap.
    this.running.delete(id);
    if (result.skipped) { await this.record(id, { lastSkipped: result.skipped }); return false; }
    if (!active()) return false;
    this.fireTimes.set(id, [...(this.fireTimes.get(id) ?? []), Date.now()]);
    await this.record(id, { lastFiredAt: new Date().toISOString(), lastEvent: event.description, lastSkipped: undefined, lastError: undefined, ...(result.workflowRunId ? { lastWorkflowRunId: result.workflowRunId } : {}) }, true);
    return true;
  }

  private async record(id: string, patch: Partial<WorkspaceTrigger>, fired = false): Promise<void> {
    await this.mutate((items) => items.map((item) => item.id === id ? { ...item, ...patch, ...(fired ? { fireCount: item.fireCount + 1 } : {}) } : item)).catch((error) => console.error("[core] could not save trigger state", error));
  }

  private async read(): Promise<WorkspaceTrigger[]> {
    let text: string;
    try { text = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new CoreError("READ_FAILED", `Could not read trigger state: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const value = JSON.parse(text) as Partial<TriggerFile>;
      if (!value || !Array.isArray(value.triggers)) throw new Error("triggers must be an array");
      this.validateStored(value.triggers);
      return value.triggers;
    } catch (error) { throw new CoreError("READ_FAILED", `Invalid trigger state in ${this.file}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private validateStored(triggers: WorkspaceTrigger[]): void {
    const ids = new Set<string>();
    for (const trigger of triggers) {
      if (!trigger || typeof trigger !== "object") throw new Error("trigger record must be an object");
      validateTrigger(trigger);
      if (typeof trigger.id !== "string" || !trigger.id.trim() || ids.has(trigger.id) || typeof trigger.rootId !== "string" || typeof trigger.enabled !== "boolean" || !Number.isInteger(trigger.fireCount)) throw new Error("saved trigger identity, root, enabled or fireCount is invalid");
      ids.add(trigger.id);
    }
  }

  private async mutate(update: (items: WorkspaceTrigger[]) => WorkspaceTrigger[]): Promise<void> {
    const write = this.writes.catch(() => undefined).then(() => serializedStateMutation(this.file, async () => {
      const items = update(await this.read());
      this.validateStored(items);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify({ triggers: items }, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close().catch(() => undefined); }
      try { await rename(temporary, this.file); } finally { await unlink(temporary).catch(() => undefined); }
      this.triggers = items;
      this.changed();
    }));
    this.writes = write;
    await write;
  }
}

/** Creates the named pipe when absent; refuses to reuse a path that is not one. */
async function ensureFifo(target: string): Promise<void> {
  if (process.platform === "win32") throw new CoreError("INVALID_REQUEST", "Named pipes (FIFO) are not supported on Windows");
  const existing = await stat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw new CoreError("READ_FAILED", `Could not inspect ${target}: ${error.message}`); });
  if (existing) { if (!existing.isFIFO()) throw new CoreError("INVALID_REQUEST", `${target} exists and is not a named pipe`); return; }
  await mkdir(path.dirname(target), { recursive: true });
  try { await execFileAsync("mkfifo", ["-m", "600", target]); }
  catch (error) { throw new CoreError("WRITE_FAILED", `Could not create named pipe ${target}: ${error instanceof Error ? error.message : String(error)}`); }
}
