import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { AiProvider } from "@remote-ide/acp";
import type { AiContinuationTimer as TimerSummary } from "@remote-ide/protocol";
import type { AcpRegistry } from "./ai/index.js";
import { appToolServer } from "./app-tools.js";
import { CoreError } from "./errors.js";
import { serializedStateMutation } from "./root-mutation.js";

export type AiContinuationTimer = TimerSummary & { workflowOperationKey?: string };
type TimerFile = { timers: AiContinuationTimer[] };

export class AiTimerStore {
  private readonly file: string;
  private readonly backup: string;
  private warnedBackupRecovery = false;
  private static readonly writes = new Map<string, Promise<unknown>>();

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = AiTimerStore.writes.get(this.file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => serializedStateMutation(this.file, operation));
    AiTimerStore.writes.set(this.file, next);
    const cleanup = () => { if (AiTimerStore.writes.get(this.file) === next) AiTimerStore.writes.delete(this.file); };
    void next.then(cleanup, cleanup);
    return next;
  }

  constructor(rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.file = path.join(stateDirectory, `${key}-ai-timers.json`);
    this.backup = `${this.file}.bak`;
  }

  async list(): Promise<AiContinuationTimer[]> {
    let primary: AiContinuationTimer[] | undefined;
    let primaryError: string | undefined;
    try {
      primary = await this.readValidFile(this.file);
    } catch (error) {
      primaryError = error instanceof Error ? error.message : String(error);
    }
    if (primary) { this.warnedBackupRecovery = false; return primary; }

    let backup: AiContinuationTimer[] | undefined;
    let backupError: string | undefined;
    try {
      backup = await this.readValidFile(this.backup);
    } catch (error) {
      backupError = error instanceof Error ? error.message : String(error);
    }
    if (backup) {
      if (!this.warnedBackupRecovery) {
        console.warn(`[core] Recovered AI continuation timers from last-good backup ${this.backup}${primaryError ? ` (primary: ${primaryError})` : " (primary is missing)"}`);
        this.warnedBackupRecovery = true;
      }
      return backup;
    }
    if (!primaryError && !backupError) return [];
    const details = [primaryError, backupError].filter(Boolean).join("; backup: ");
    throw new CoreError("READ_FAILED", `Could not read AI continuation timer state (${details})`);
  }

  private async readValidFile(file: string): Promise<AiContinuationTimer[] | undefined> {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state must be a JSON object");
      const timers = (value as Partial<TimerFile>).timers;
      if (!Array.isArray(timers)) throw new Error("timers must be an array");
      if (!timers.every(isTimer)) throw new Error("every timer record must be valid");
      if (new Set(timers.map((timer) => timer.id)).size !== timers.length) throw new Error("timer IDs must be unique");
      return timers;
    } catch (error) {
      throw new Error(`Invalid timer state in ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async set(workspace: string, provider: AiProvider, prompt: string, seconds: number, workflow?: { runId: string; blockId: string; flow?: boolean; operationKey?: string }): Promise<AiContinuationTimer> {
    return this.setAt(workspace, provider, prompt, new Date(Date.now() + seconds * 1_000).toISOString(), workflow);
  }

  async setAt(workspace: string, provider: AiProvider, prompt: string, dueAt: string, workflow?: { runId: string; blockId: string; flow?: boolean; operationKey?: string }): Promise<AiContinuationTimer> {
    return this.mutate(async () => {
    const timers = await this.list();
    const existing = workflow?.operationKey ? timers.find((item) => item.workflowRunId === workflow.runId && item.workflowBlockId === workflow.blockId && item.workflowOperationKey === workflow.operationKey) : undefined;
    if (existing) return existing;
    const now = new Date();
    const timer = { id: crypto.randomUUID(), workspace: path.resolve(workspace), provider, prompt, createdAt: now.toISOString(), dueAt, ...(workflow ? { workflowRunId: workflow.runId, workflowBlockId: workflow.blockId, ...(workflow.flow ? { workflowFlow: true } : {}), ...(workflow.operationKey ? { workflowOperationKey: workflow.operationKey } : {}) } : {}) };
    if (!isTimer(timer)) throw new CoreError("INVALID_REQUEST", "Timer fields and timestamps must be valid");
    await this.save([...timers.filter((item) => item.workspace !== timer.workspace || item.provider !== provider), timer], timers);
    return timer;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      const timers = await this.list();
      await this.save(timers.filter((timer) => timer.id !== id), timers);
    });
  }

  async removeWorkspace(workspace: string): Promise<AiContinuationTimer[]> {
    return this.mutate(async () => {
    const resolved = path.resolve(workspace);
    const timers = await this.list();
    const removed = timers.filter((timer) => timer.workspace === resolved);
    await this.save(timers.filter((timer) => timer.workspace !== resolved), timers);
    return removed;
    });
  }

  async next(workspace: string, provider?: AiProvider): Promise<AiContinuationTimer | undefined> {
    const resolved = path.resolve(workspace);
    return (await this.list()).filter((timer) => timer.workspace === resolved && (!provider || timer.provider === provider)).sort((left, right) => left.dueAt.localeCompare(right.dueAt))[0];
  }

  private async save(timers: AiContinuationTimer[], previous: AiContinuationTimer[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.atomicWrite(this.backup, previous);
    await this.atomicWrite(this.file, timers);
  }

  private async atomicWrite(file: string, timers: AiContinuationTimer[]): Promise<void> {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ timers }, null, 2)}\n`, "utf8");
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

export class AiTimerService {
  private suspended = false;
  private readonly pendingDeliveries = new Set<Promise<void>>();
  /** Stop local delivery handles without deleting durable continuation timers. */
  async suspend(): Promise<void> { this.suspended = true; for (const handle of this.handles.values()) clearTimeout(handle); this.handles.clear(); await Promise.all([...this.pendingDeliveries]); }

  private readonly handles = new Map<string, NodeJS.Timeout>();
  private readonly delivering = new Set<string>();
  private readonly timerCancellationEpochs = new Map<string, number>();
  private readonly cancellationEpochs = new Map<string, number>();

  constructor(private readonly store: AiTimerStore, private readonly acp: AcpRegistry, private readonly rootWorkspace: string, private readonly onChanged: (workspace: string) => void, private readonly workflowOperation?: <T>(timer: AiContinuationTimer, effect: () => Promise<T>, reconcile: () => Promise<T | null | undefined>) => Promise<T>) {}

  async start(): Promise<void> { for (const timer of await this.store.list()) this.arm(timer); }

  async schedule(workspace: string, provider: AiProvider, prompt: string, seconds: number, workflow?: { runId: string; blockId: string; flow?: boolean; operationKey?: string }): Promise<AiContinuationTimer> {
    const timer = await this.store.set(workspace, provider, prompt, seconds, workflow);
    return this.activate(timer);
  }

  async scheduleAt(workspace: string, provider: AiProvider, prompt: string, dueAt: string, workflow?: { runId: string; blockId: string; flow?: boolean; operationKey?: string }): Promise<AiContinuationTimer> {
    const timer = await this.store.setAt(workspace, provider, prompt, dueAt, workflow);
    return this.activate(timer);
  }

  private async activate(timer: AiContinuationTimer): Promise<AiContinuationTimer> {
    const activeIds = new Set((await this.store.list()).map((item) => item.id));
    for (const [id, handle] of this.handles) {
      if (!activeIds.has(id)) { clearTimeout(handle); this.handles.delete(id); }
    }
    this.arm(timer);
    this.onChanged(timer.workspace);
    return timer;
  }

  next(workspace: string, provider?: AiProvider): Promise<AiContinuationTimer | undefined> { return this.store.next(workspace, provider); }

  list(): Promise<AiContinuationTimer[]> { return this.store.list().then((timers) => timers.sort((a, b) => a.dueAt.localeCompare(b.dueAt))); }

  async cancel(id: string): Promise<boolean> {
    const timer = (await this.store.list()).find((item) => item.id === id);
    if (!timer) return false;
    this.timerCancellationEpochs.set(id, (this.timerCancellationEpochs.get(id) ?? 0) + 1);
    await this.store.remove(id);
    const handle = this.handles.get(id);
    if (handle) clearTimeout(handle);
    this.handles.delete(id);
    this.onChanged(timer.workspace);
    return true;
  }

  async fireById(id: string): Promise<boolean> {
    if (this.suspended) return false;
    const timer = (await this.store.list()).find((item) => item.id === id);
    if (!timer) return false;
    await this.fire(timer, true);
    return true;
  }

  async cancelAll(): Promise<number> {
    let cancelled = 0;
    for (const timer of await this.list()) if (await this.cancel(timer.id)) cancelled += 1;
    return cancelled;
  }

  async cancelProvider(workspace: string, provider: AiProvider): Promise<void> {
    for (const timer of await this.list()) if (timer.workspace === path.resolve(workspace) && timer.provider === provider) await this.cancel(timer.id);
  }

  async cancelNext(workspace: string): Promise<boolean> {
    const timer = await this.store.next(workspace);
    return timer ? this.cancel(timer.id) : false;
  }

  async fireNext(workspace: string, provider?: AiProvider): Promise<boolean> {
    if (this.suspended) return false;
    const timer = await this.store.next(workspace, provider);
    if (!timer) return false;
    await this.fire(timer, true);
    return true;
  }

  async cancelWorkspace(workspace: string): Promise<void> {
    const key = path.resolve(workspace);
    this.cancellationEpochs.set(key, (this.cancellationEpochs.get(key) ?? 0) + 1);
    for (const timer of await this.store.removeWorkspace(workspace)) {
      const handle = this.handles.get(timer.id);
      if (handle) clearTimeout(handle);
      this.handles.delete(timer.id);
    }
    this.onChanged(path.resolve(workspace));
  }

  private arm(timer: AiContinuationTimer): void {
    if (this.suspended) return;
    this.handles.get(timer.id) && clearTimeout(this.handles.get(timer.id));
    const delay = Math.max(0, new Date(timer.dueAt).getTime() - Date.now());
    this.handles.set(timer.id, setTimeout(() => { void this.fire(timer).catch((error) => console.error(`[core] workflow timer journal failed: ${error instanceof Error ? error.message : String(error)}`)); }, Math.min(delay, 2_147_483_647)));
  }

  private fire(timer: AiContinuationTimer, immediately = false): Promise<void> {
    if (this.suspended) return Promise.resolve();
    const pending = this.fireNow(timer, immediately);
    this.pendingDeliveries.add(pending);
    void pending.finally(() => this.pendingDeliveries.delete(pending)).catch(() => undefined);
    return pending;
  }

  private async fireNow(timer: AiContinuationTimer, immediately = false): Promise<void> {
    const result = timer.workflowRunId && timer.workflowBlockId && this.workflowOperation
      ? await this.workflowOperation(timer, () => this.deliver(timer, immediately), () => this.reconcileDelivery(timer))
      : await this.deliver(timer, immediately);
    if (!result.delivered) return;
    await this.store.remove(timer.id);
    this.onChanged(timer.workspace);
  }

  private async deliver(timer: AiContinuationTimer, immediately = false): Promise<{ delivered: boolean }> {
    if (this.delivering.has(timer.id)) return { delivered: false };
    this.delivering.add(timer.id);
    const epoch = this.cancellationEpochs.get(timer.workspace) ?? 0;
    const timerEpoch = this.timerCancellationEpochs.get(timer.id) ?? 0;
    const cancelled = () => (this.cancellationEpochs.get(timer.workspace) ?? 0) !== epoch || (this.timerCancellationEpochs.get(timer.id) ?? 0) !== timerEpoch;
    try {
    const handle = this.handles.get(timer.id);
    if (immediately && handle) clearTimeout(handle);
    this.handles.delete(timer.id);
    if (!immediately && new Date(timer.dueAt).getTime() > Date.now()) { this.arm(timer); return { delivered: false }; }
    const current = (await this.store.list()).find((item) => item.id === timer.id);
    if (!current) return { delivered: true };
    const manager = this.acp.get(timer.provider);
    const session = await manager.get(timer.workspace);
      if (cancelled()) return { delivered: true };
      if (session.status === "in_progress" || session.status === "user_prompt") await manager.steer(timer.workspace, timer.prompt);
      else await manager.send(timer.workspace, { prompt: timer.prompt, configuration: session.configuration ?? { model: session.model, reasoning: session.reasoning }, mcpServers: [appToolServer(this.rootWorkspace, timer.workspace, timer.provider, this.rootWorkspace, timer.workflowRunId && timer.workflowBlockId ? { runId: timer.workflowRunId, blockId: timer.workflowBlockId, flow: timer.workflowFlow } : undefined)] });
      if (cancelled()) { await manager.interrupt(timer.workspace); return { delivered: true }; }
      return { delivered: true };
    } finally { this.delivering.delete(timer.id); this.onChanged(timer.workspace); }
  }

  private async reconcileDelivery(timer: AiContinuationTimer): Promise<{ delivered: boolean } | null | undefined> {
    const current = (await this.store.list()).find((item) => item.id === timer.id);
    const session = await this.acp.get(timer.provider).get(timer.workspace).catch(() => undefined);
    if (session?.messages.some((message) => message.role === "user" && message.text === timer.prompt)) {
      return { delivered: true };
    }
    return current ? null : undefined;
  }
}

function isTimer(value: unknown): value is AiContinuationTimer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const timer = value as Record<string, unknown>;
  return typeof timer.id === "string" && timer.id.trim().length > 0 && typeof timer.workspace === "string" && timer.workspace.trim().length > 0 && typeof timer.provider === "string" && timer.provider.trim().length > 0 && typeof timer.prompt === "string" && typeof timer.dueAt === "string" && Number.isFinite(Date.parse(timer.dueAt)) && typeof timer.createdAt === "string" && Number.isFinite(Date.parse(timer.createdAt)) && (timer.workflowRunId === undefined || typeof timer.workflowRunId === "string") && (timer.workflowBlockId === undefined || typeof timer.workflowBlockId === "string") && (timer.workflowOperationKey === undefined || typeof timer.workflowOperationKey === "string") && (timer.workflowFlow === undefined || typeof timer.workflowFlow === "boolean");
}
