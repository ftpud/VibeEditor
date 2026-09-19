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
    const value = await this.readJson<unknown>("index.json", { schemaVersion: SCHEMA_VERSION, definitions: [] });
    const definitions = Array.isArray(value) ? value : isRecord(value) && value.schemaVersion === SCHEMA_VERSION && Array.isArray(value.definitions) ? value.definitions : undefined;
    if (!definitions) throw new CoreError("READ_FAILED", "Could not list harnesses: unsupported or malformed state schema");
    return definitions.filter(isHarness).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    const value = await this.readJson<unknown>("runs.json", { schemaVersion: SCHEMA_VERSION, runs: [] });
    const runs = Array.isArray(value) ? value : isRecord(value) && value.schemaVersion === SCHEMA_VERSION && Array.isArray(value.runs) ? value.runs : undefined;
    if (!runs) throw new CoreError("READ_FAILED", "Could not list harness runs: unsupported or malformed state schema");
    return runs.filter(isRun).filter((run) => !harnessId || run.harnessId === harnessId).slice(0, RUNS_PER_WORKFLOW);
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
        if (!["queued", "running", "waiting"].includes(run.status)) continue;
        run.status = "failed"; run.completedAt = now; run.error = "Core restarted before this workflow completed. Inspect existing sessions and tasks, then start a new run or clean up the preserved work.";
        for (const block of run.blocks) {
          if (!["queued", "running", "waiting"].includes(block.status)) continue;
          block.status = block.status === "running" ? "failed" : "cancelled"; block.completedAt = now;
          if (block.status === "failed") { block.error = run.error; block.failureReason = "permanent"; }
        }
        recovered.push(structuredClone(run));
      }
      if (recovered.length) await this.writeJson("runs.json", { schemaVersion: SCHEMA_VERSION, runs } satisfies RunFile);
      return recovered;
    });
  }

  private async persist(harnesses: HarnessDefinition[]): Promise<void> { await this.writeJson("index.json", { schemaVersion: SCHEMA_VERSION, definitions: harnesses } satisfies DefinitionFile); }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    const target = path.join(this.directory, name);
    try { return JSON.parse(await readFile(target, "utf8")) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      try { return JSON.parse(await readFile(`${target}.bak`, "utf8")) as T; }
      catch { throw new CoreError("READ_FAILED", `Could not read workflow state ${name}: ${message(error)}`); }
    }
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
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object"; }
function isRun(value: unknown): value is HarnessRun { return isRecord(value) && typeof value.id === "string" && typeof value.harnessId === "string" && typeof value.harnessVersion === "number" && typeof value.input === "string" && typeof value.status === "string" && typeof value.createdAt === "string" && Array.isArray(value.blocks); }
function isHarness(value: unknown): value is HarnessDefinition {
  if (!value || typeof value !== "object") return false; const item = value as Partial<HarnessDefinition>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.version === "number" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && Array.isArray(item.blocks) && Array.isArray(item.edges)
    && item.blocks.every((block) => block && typeof block.id === "string" && ["prompt", "task"].includes(block.type) && typeof block.label === "string" && typeof block.prompt === "string" && (!block.join || block.join === "all" || block.join === "any") && (!block.routing || block.routing === "all" || block.routing === "ai") && typeof block.position?.x === "number" && typeof block.position?.y === "number")
    && item.edges.every((edge) => edge && typeof edge.id === "string" && typeof edge.from === "string" && typeof edge.to === "string" && (edge.label === undefined || typeof edge.label === "string") && (edge.loop === undefined || typeof edge.loop === "boolean") && (edge.execution === undefined || edge.execution === "sync" || edge.execution === "async"));
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
