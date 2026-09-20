import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

const SCHEMA_VERSION = 1;
const RUNS_PER_WORKFLOW = 100;
type DefinitionFile = { schemaVersion: number; definitions: HarnessDefinition[] };
type RunFile = { schemaVersion: number; runs: HarnessRun[] };
const mutationQueues = new Map<string, Promise<void>>();

export class HarnessStore {
  private readonly directory: string;

  constructor(rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.directory = path.join(stateDirectory, "harnesses", key);
  }

  async list(): Promise<HarnessDefinition[]> {
    return (await this.readRecords("index.json", "definitions", isHarness)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(name: string): Promise<HarnessDefinition> {
    return this.mutate(async () => {
      const now = new Date().toISOString();
      const harness: HarnessDefinition = { id: crypto.randomUUID(), name: validName(name), version: 1, createdAt: now, updatedAt: now, blocks: [], edges: [] };
      await this.persist([harness, ...await this.list()]);
      return harness;
    });
  }

  async update(candidate: HarnessDefinition): Promise<HarnessDefinition> {
    if (!isHarness(candidate)) throw new CoreError("INVALID_REQUEST", "Invalid harness definition");
    return this.mutate(async () => {
      const current = await this.list(); const previous = current.find((item) => item.id === candidate.id);
      if (!previous) throw new CoreError("FILE_NOT_FOUND", "Harness does not exist");
      if (candidate.version !== previous.version) throw new CoreError("INVALID_REQUEST", `Workflow changed since it was opened (expected version ${candidate.version}, current version ${previous.version}). Reload it before saving.`);
      const updated = { ...candidate, name: validName(candidate.name), createdAt: previous.createdAt, updatedAt: new Date().toISOString(), version: previous.version + 1 };
      await this.persist(current.map((item) => item.id === updated.id ? updated : item)); return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate(async () => { const current = await this.list(); if (!current.some((item) => item.id === id)) throw new CoreError("FILE_NOT_FOUND", "Harness does not exist"); await this.persist(current.filter((item) => item.id !== id)); });
  }

  async read(id: string): Promise<HarnessDefinition> { const harness = (await this.list()).find((item) => item.id === id); if (!harness) throw new CoreError("FILE_NOT_FOUND", "Harness does not exist"); return harness; }

  async runs(harnessId?: string): Promise<HarnessRun[]> {
    return (await this.readRecords("runs.json", "runs", isRun)).filter((run) => !harnessId || run.harnessId === harnessId).slice(0, RUNS_PER_WORKFLOW);
  }

  async saveRun(run: HarnessRun): Promise<void> {
    await this.mutate(async () => {
      const merged = [structuredClone(run), ...(await this.runs()).filter((item) => item.id !== run.id)]; const counts = new Map<string, number>();
      const retained = merged.filter((item) => { const count = counts.get(item.harnessId) ?? 0; counts.set(item.harnessId, count + 1); return count < RUNS_PER_WORKFLOW; });
      await this.writeJson("runs.json", { schemaVersion: SCHEMA_VERSION, runs: retained } satisfies RunFile);
    });
  }

  async recoverInterruptedRuns(): Promise<HarnessRun[]> {
    return this.mutate(async () => {
      const runs = await this.runs(); const recovered: HarnessRun[] = []; const now = new Date().toISOString();
      for (const run of runs) {
        if (!activeRunStatuses.has(run.status)) continue;
        run.status = "failed"; run.completedAt = now; run.error = "Core restarted before this workflow completed. Inspect existing sessions and tasks, then start a new run or clean up the preserved work.";
        for (const block of run.blocks) {
          if (!activeBlockStatuses.has(block.status)) continue;
          const previous = block.status; block.status = ["running", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"].includes(previous) ? "failed" : "cancelled"; block.completedAt = now;
          if (block.status === "failed") { block.error = run.error; block.failureReason = previous === "awaiting_permission" ? "permission_required" : previous === "awaiting_user_input" ? "user_input_required" : "permanent"; }
        }
        recovered.push(structuredClone(run));
      }
      if (recovered.length) await this.writeJson("runs.json", { schemaVersion: SCHEMA_VERSION, runs } satisfies RunFile);
      return recovered;
    });
  }

  private async persist(harnesses: HarnessDefinition[]): Promise<void> { await this.writeJson("index.json", { schemaVersion: SCHEMA_VERSION, definitions: harnesses } satisfies DefinitionFile); }

  private async readRecords<T>(name: string, field: "definitions" | "runs", valid: (value: unknown) => value is T): Promise<T[]> {
    const target = path.join(this.directory, name);
    let currentError: unknown;
    for (const candidate of [target, `${target}.bak`]) {
      let raw: string;
      try { raw = await readFile(candidate, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        currentError ??= error; continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        const records = Array.isArray(parsed) ? parsed : isRecord(parsed) && parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed[field]) ? parsed[field] : undefined;
        if (!records) throw new Error("unsupported or malformed state schema");
        const accepted = records.filter(valid); const rejected = records.filter((record) => !valid(record));
        if (rejected.length) await this.quarantine(name, "Records failed schema validation", rejected);
        return accepted;
      } catch (error) {
        currentError ??= error;
        await this.quarantine(name, message(error), raw);
      }
    }
    if (!currentError) return [];
    throw new CoreError("READ_FAILED", `Could not read workflow state ${name}: ${message(currentError)}`);
  }

  private async quarantine(source: string, reason: string, value: unknown): Promise<void> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const fingerprint = crypto.createHash("sha256").update(`${source}\0${serialized}`).digest("hex").slice(0, 16);
    const directory = path.join(this.directory, "quarantine");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${source}.${fingerprint}.json`), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, source, reason, quarantinedAt: new Date().toISOString(), value }, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
      .catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true }); const target = path.join(this.directory, name); const temporary = path.join(this.directory, `${name}.${crypto.randomUUID()}.tmp`);
    try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await copyFile(target, `${target}.bak`).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw new CoreError("WRITE_FAILED", `Could not save workflows: ${message(error)}`); }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const queue = mutationQueues.get(this.directory) ?? Promise.resolve(); const result = queue.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined); mutationQueues.set(this.directory, settled);
    void settled.finally(() => { if (mutationQueues.get(this.directory) === settled) mutationQueues.delete(this.directory); });
    return result;
  }
}

function validName(name: string): string { const value = name.trim(); if (!value || value.length > 120) throw new CoreError("INVALID_REQUEST", "Harness name must contain 1–120 characters"); return value; }
const activeRunStatuses = new Set<HarnessRun["status"]>(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);
const activeBlockStatuses = new Set<HarnessRun["blocks"][number]["status"]>(["queued", "running", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"]);
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object"; }
function isRun(value: unknown): value is HarnessRun {
  const statuses = ["queued", "running", "succeeded", "failed", "cancelled", "waiting", "awaiting_permission", "awaiting_user_input", "waiting_timer", "retry_scheduled"];
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.harnessId !== "string" || typeof value.harnessVersion !== "number" || typeof value.input !== "string" || !statuses.includes(String(value.status)) || typeof value.createdAt !== "string" || !Array.isArray(value.blocks)) return false;
  if (value.definition !== undefined && !isHarness(value.definition)) return false;
  if (value.cleanupErrors !== undefined && (!Array.isArray(value.cleanupErrors) || !value.cleanupErrors.every((item) => typeof item === "string"))) return false;
  if (value.children !== undefined && (!Array.isArray(value.children) || !value.children.every((child) => isRecord(child) && typeof child.taskId === "string" && typeof child.blockId === "string" && typeof child.provider === "string" && typeof child.workspace === "string" && Number.isInteger(child.recoveryAttempts)))) return false;
  return value.blocks.every((block) => isRecord(block) && typeof block.blockId === "string" && [...statuses, "skipped"].includes(String(block.status))
    && (block.question === undefined || typeof block.question === "string")
    && (block.pendingPermission === undefined || isRecord(block.pendingPermission) && typeof block.pendingPermission.id === "string" && typeof block.pendingPermission.title === "string" && typeof block.pendingPermission.toolCallId === "string" && Array.isArray(block.pendingPermission.options) && block.pendingPermission.options.every((option) => isRecord(option) && typeof option.optionId === "string" && typeof option.name === "string" && ["allow_once", "allow_always", "reject_once", "reject_always"].includes(String(option.kind))))
    && (block.log === undefined || Array.isArray(block.log) && block.log.every((entry) => isRecord(entry) && typeof entry.timestamp === "string" && ["lifecycle", "prompt", "response", "error"].includes(String(entry.kind)) && typeof entry.message === "string"))
    && (block.iterations === undefined || Array.isArray(block.iterations) && block.iterations.every((iteration) => isRecord(iteration) && Number.isInteger(iteration.index) && ["running", "succeeded", "failed", "cancelled"].includes(String(iteration.status)) && typeof iteration.startedAt === "string")));
}
function isHarness(value: unknown): value is HarnessDefinition {
  if (!value || typeof value !== "object") return false; const item = value as Partial<HarnessDefinition>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.version === "number" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && Array.isArray(item.blocks) && Array.isArray(item.edges)
    && item.blocks.every((block) => block && typeof block.id === "string" && ["prompt", "task"].includes(block.type) && typeof block.label === "string" && typeof block.prompt === "string" && (block.provider === undefined || typeof block.provider === "string") && (block.model === undefined || typeof block.model === "string") && (block.watchdog === undefined || typeof block.watchdog === "boolean") && (block.agent === undefined || typeof block.agent.name === "string" && ["global", "local", "workspace"].includes(block.agent.scope)) && (!block.join || block.join === "all" || block.join === "any") && (!block.routing || block.routing === "all" || block.routing === "ai") && typeof block.position?.x === "number" && typeof block.position?.y === "number")
    && item.edges.every((edge) => edge && typeof edge.id === "string" && typeof edge.from === "string" && typeof edge.to === "string" && (edge.label === undefined || typeof edge.label === "string") && (edge.loop === undefined || typeof edge.loop === "boolean") && (edge.execution === undefined || edge.execution === "sync" || edge.execution === "async"));
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
