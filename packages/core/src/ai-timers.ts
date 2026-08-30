import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { AiProvider } from "@remote-ide/acp";
import type { AcpRegistry } from "./ai/index.js";
import { appToolServer } from "./app-tools.js";

export type AiContinuationTimer = { id: string; workspace: string; provider: AiProvider; prompt: string; dueAt: string; createdAt: string };
type TimerFile = { timers: AiContinuationTimer[] };

export class AiTimerStore {
  private readonly file: string;

  constructor(rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.file = path.join(stateDirectory, `${key}-ai-timers.json`);
  }

  async list(): Promise<AiContinuationTimer[]> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as Partial<TimerFile>;
      return Array.isArray(value.timers) ? value.timers.filter(isTimer) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async set(workspace: string, provider: AiProvider, prompt: string, seconds: number): Promise<AiContinuationTimer> {
    const timers = await this.list();
    const now = new Date();
    const timer = { id: crypto.randomUUID(), workspace: path.resolve(workspace), provider, prompt, createdAt: now.toISOString(), dueAt: new Date(now.getTime() + seconds * 1_000).toISOString() };
    await this.save([...timers.filter((item) => item.workspace !== timer.workspace || item.provider !== provider), timer]);
    return timer;
  }

  async remove(id: string): Promise<void> { await this.save((await this.list()).filter((timer) => timer.id !== id)); }

  async removeWorkspace(workspace: string): Promise<AiContinuationTimer[]> {
    const resolved = path.resolve(workspace);
    const timers = await this.list();
    const removed = timers.filter((timer) => timer.workspace === resolved);
    await this.save(timers.filter((timer) => timer.workspace !== resolved));
    return removed;
  }

  async next(workspace: string): Promise<AiContinuationTimer | undefined> {
    const resolved = path.resolve(workspace);
    return (await this.list()).filter((timer) => timer.workspace === resolved).sort((left, right) => left.dueAt.localeCompare(right.dueAt))[0];
  }

  private async save(timers: AiContinuationTimer[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ timers }, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}

export class AiTimerService {
  private readonly handles = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: AiTimerStore, private readonly acp: AcpRegistry, private readonly rootWorkspace: string, private readonly onChanged: (workspace: string) => void) {}

  async start(): Promise<void> { for (const timer of await this.store.list()) this.arm(timer); }

  async schedule(workspace: string, provider: AiProvider, prompt: string, seconds: number): Promise<AiContinuationTimer> {
    const timer = await this.store.set(workspace, provider, prompt, seconds);
    const activeIds = new Set((await this.store.list()).map((item) => item.id));
    for (const [id, handle] of this.handles) {
      if (!activeIds.has(id)) { clearTimeout(handle); this.handles.delete(id); }
    }
    this.arm(timer);
    this.onChanged(timer.workspace);
    return timer;
  }

  next(workspace: string): Promise<AiContinuationTimer | undefined> { return this.store.next(workspace); }

  async cancelNext(workspace: string): Promise<boolean> {
    const timer = await this.store.next(workspace);
    if (!timer) return false;
    await this.store.remove(timer.id);
    const handle = this.handles.get(timer.id);
    if (handle) clearTimeout(handle);
    this.handles.delete(timer.id);
    this.onChanged(timer.workspace);
    return true;
  }

  async fireNext(workspace: string): Promise<boolean> {
    const timer = await this.store.next(workspace);
    if (!timer) return false;
    await this.fire(timer, true);
    return true;
  }

  async cancelWorkspace(workspace: string): Promise<void> {
    for (const timer of await this.store.removeWorkspace(workspace)) {
      const handle = this.handles.get(timer.id);
      if (handle) clearTimeout(handle);
      this.handles.delete(timer.id);
    }
    this.onChanged(path.resolve(workspace));
  }

  private arm(timer: AiContinuationTimer): void {
    this.handles.get(timer.id) && clearTimeout(this.handles.get(timer.id));
    const delay = Math.max(0, new Date(timer.dueAt).getTime() - Date.now());
    this.handles.set(timer.id, setTimeout(() => { void this.fire(timer); }, Math.min(delay, 2_147_483_647)));
  }

  private async fire(timer: AiContinuationTimer, immediately = false): Promise<void> {
    const handle = this.handles.get(timer.id);
    if (immediately && handle) clearTimeout(handle);
    this.handles.delete(timer.id);
    if (!immediately && new Date(timer.dueAt).getTime() > Date.now()) { this.arm(timer); return; }
    const current = (await this.store.list()).find((item) => item.id === timer.id);
    if (!current) return;
    await this.store.remove(timer.id);
    this.onChanged(timer.workspace);
    const manager = this.acp.get(timer.provider);
    const session = await manager.get(timer.workspace);
    try {
      if (session.status === "in_progress" || session.status === "user_prompt") await manager.steer(timer.workspace, timer.prompt);
      else await manager.send(timer.workspace, { prompt: timer.prompt, configuration: session.configuration ?? { model: session.model, reasoning: session.reasoning }, mcpServers: [appToolServer(this.rootWorkspace, timer.workspace, timer.provider)] });
    } catch (error) {
      console.error(`[core] continuation timer failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.onChanged(timer.workspace); }
  }
}

function isTimer(value: unknown): value is AiContinuationTimer {
  if (!value || typeof value !== "object") return false;
  const timer = value as Record<string, unknown>;
  return typeof timer.id === "string" && typeof timer.workspace === "string" && typeof timer.provider === "string" && typeof timer.prompt === "string" && typeof timer.dueAt === "string" && typeof timer.createdAt === "string";
}
