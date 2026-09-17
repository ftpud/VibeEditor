import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { HarnessDefinition, HarnessRun } from "@remote-ide/protocol";
import { CoreError } from "./errors.js";

export class HarnessStore {
  private readonly directory: string;

  constructor(rootWorkspace: string, stateDirectory = process.env.REMOTE_IDE_STATE_DIR ?? path.join(os.homedir(), ".remote-ide", "workspaces")) {
    const key = crypto.createHash("sha256").update(rootWorkspace).digest("hex");
    this.directory = path.join(stateDirectory, "harnesses", key);
  }

  async list(): Promise<HarnessDefinition[]> {
    try {
      const index = JSON.parse(await readFile(path.join(this.directory, "index.json"), "utf8")) as unknown;
      if (!Array.isArray(index)) return [];
      return index.filter(isHarness).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new CoreError("READ_FAILED", `Could not list harnesses: ${message(error)}`);
    }
  }

  async create(name: string): Promise<HarnessDefinition> {
    const now = new Date().toISOString();
    const harness: HarnessDefinition = { id: crypto.randomUUID(), name: validName(name), version: 1, createdAt: now, updatedAt: now, blocks: [], edges: [] };
    const current = await this.list();
    await this.persist([harness, ...current]);
    return harness;
  }

  async update(candidate: HarnessDefinition): Promise<HarnessDefinition> {
    if (!isHarness(candidate)) throw new CoreError("INVALID_REQUEST", "Invalid harness definition");
    const current = await this.list();
    const previous = current.find((item) => item.id === candidate.id);
    if (!previous) throw new CoreError("FILE_NOT_FOUND", "Harness does not exist");
    const updated = { ...candidate, name: validName(candidate.name), createdAt: previous.createdAt, updatedAt: new Date().toISOString(), version: previous.version + 1 };
    await this.persist(current.map((item) => item.id === updated.id ? updated : item));
    return updated;
  }

  async delete(id: string): Promise<void> {
    const current = await this.list();
    if (!current.some((item) => item.id === id)) throw new CoreError("FILE_NOT_FOUND", "Harness does not exist");
    await this.persist(current.filter((item) => item.id !== id));
  }

  async read(id: string): Promise<HarnessDefinition> {
    const harness = (await this.list()).find((item) => item.id === id);
    if (!harness) throw new CoreError("FILE_NOT_FOUND", "Harness does not exist");
    return harness;
  }

  async runs(harnessId?: string): Promise<HarnessRun[]> {
    try {
      const runs = JSON.parse(await readFile(path.join(this.directory, "runs.json"), "utf8")) as HarnessRun[];
      return (Array.isArray(runs) ? runs : []).filter((run) => !harnessId || run.harnessId === harnessId).slice(0, 100);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new CoreError("READ_FAILED", `Could not list harness runs: ${message(error)}`); }
  }

  async saveRun(run: HarnessRun): Promise<void> {
    const runs = await this.runs(); const next = [run, ...runs.filter((item) => item.id !== run.id)].slice(0, 100);
    await this.writeJson("runs.json", next);
  }

  private async persist(harnesses: HarnessDefinition[]): Promise<void> {
    await this.writeJson("index.json", harnesses);
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, name);
    const temporary = path.join(this.directory, `${name}.${crypto.randomUUID()}.tmp`);
    try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw new CoreError("WRITE_FAILED", `Could not save harnesses: ${message(error)}`); }
  }
}

function validName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 120) throw new CoreError("INVALID_REQUEST", "Harness name must contain 1–120 characters");
  return value;
}

function isHarness(value: unknown): value is HarnessDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HarnessDefinition>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.version === "number" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" && Array.isArray(item.blocks) && Array.isArray(item.edges)
    && item.blocks.every((block) => block && typeof block.id === "string" && ["prompt", "task"].includes(block.type) && typeof block.label === "string" && typeof block.prompt === "string" && (!block.join || block.join === "all" || block.join === "any") && (!block.routing || block.routing === "all" || block.routing === "ai") && typeof block.position?.x === "number" && typeof block.position?.y === "number")
    && item.edges.every((edge) => edge && typeof edge.id === "string" && typeof edge.from === "string" && typeof edge.to === "string" && (edge.label === undefined || typeof edge.label === "string"));
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
